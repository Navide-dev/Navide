// The public `shell.run` policy of the Host's Python broker
// (backend/agent_team_backend/host_shell.py: validate_public_argv and its
// helpers, plus git_security's remote-form checks), ported for
// `navide-plugin dev-backend --workspace`. A command the local bridge refuses
// is refused by Navide too; the constants are copied, so keep them in step
// with host_shell.py when that file changes.

export const HOST_SHELL_EXECUTABLE_ALLOWLIST = new Set(['git', 'gh', 'glab'])
const SHELL_SYNTAX = /[;&|<>`\n\r]/
const PUBLIC_GIT_COMMANDS = new Set([
  'add', 'am', 'apply', 'bisect', 'blame', 'branch', 'checkout', 'cherry-pick', 'clean', 'clone', 'commit', 'describe',
  'diff', 'fetch', 'for-each-ref', 'init', 'log', 'ls-files', 'merge', 'mv', 'pull', 'push', 'rebase', 'reflog', 'remote',
  'reset', 'restore', 'revert', 'rev-list', 'rev-parse', 'show', 'stash', 'status', 'submodule', 'switch', 'tag', 'worktree',
])
const PUBLIC_GH_COMMANDS = new Set(['api', 'cache', 'gist', 'issue', 'label', 'pr', 'release', 'repo', 'run', 'search', 'status', 'variable', 'workflow'])
const PUBLIC_GLAB_COMMANDS = new Set(['api', 'ci', 'deploy-key', 'incident', 'issue', 'label', 'milestone', 'mr', 'release', 'repo', 'schedule', 'snippet', 'variable'])
const PUBLIC_GIT_OVERRIDE_OPTIONS = ['--config', '--config-env', '--exec-path', '--git-dir', '--receive-pack', '--template', '--upload-pack', '--work-tree']
const PUBLIC_GIT_BOOLEAN_OPTIONS = new Set([
  '--all', '--ahead-behind', '--bare', '--branch', '--cached', '--check', '--column', '--decorate', '--delete', '--detach',
  '--dry-run', '--ff-only', '--follow', '--force', '--graph', '--ignored', '--literal-pathspecs', '--name-only', '--name-status',
  '--no-ahead-behind', '--no-edit', '--no-ff', '--no-rebase', '--no-renames', '--no-tags', '--no-track', '--no-verify',
  '--oneline', '--porcelain', '--prune', '--quiet', '--rebase', '--set-upstream', '--short', '--show-current', '--show-stash',
  '--staged', '--stat', '--summary', '--tags', '--track', '--untracked-files', '--verbose', '-A', '-u', '-v',
])
const PUBLIC_GIT_VALUE_OPTIONS = new Set(['--author', '--branch', '--format', '--grep', '--max-count', '--message', '--since', '--strategy', '--until', '-b', '-m', '-n'])
const PUBLIC_GIT_PATH_VALUE_OPTIONS = new Set(['--file'])
const PUBLIC_PROVIDER_FORBIDDEN_NESTED = new Set(['alias', 'auth', 'clone', 'config', 'exec', 'extension', 'fork', 'helper', 'ssh', 'token'])
const PUBLIC_PROVIDER_SUBCOMMANDS = {
  gh: {
    issue: new Set(['list', 'view', 'create', 'comment']),
    pr: new Set(['list', 'view', 'create', 'comment']),
    repo: new Set(['list', 'view', 'status']),
    run: new Set(['list', 'view']),
  },
  glab: {
    issue: new Set(['list', 'view', 'create', 'note']),
    mr: new Set(['list', 'view']),
    repo: new Set(['list', 'view']),
  },
}
const PUBLIC_PROVIDER_VALUE_OPTIONS = new Set([
  '--assignee', '--author', '--body', '--description', '--json', '--label', '--limit', '--message', '--milestone', '--output',
  '--per-page', '--search', '--state', '--title',
])
const PUBLIC_PROVIDER_BOOLEAN_OPTIONS = new Set(['--all', '--comments'])
const REMOTE_HELPER = /^[A-Za-z][A-Za-z0-9+.-]*::/
const SCP_REMOTE = /^(?:(?<user>[^/@:\s]+)@)?(?<host>[^/@:\s]+):(?<path>[^\s]+)$/
const WINDOWS_PATH = /^[A-Za-z]:[\\/]/
const DECLARED_EXECUTABLE = /^[a-z0-9][a-z0-9._+-]{0,63}$/
const DECLARED_EXTENSION = /\.(exe|cmd|bat|com|ps1)$/

import { basename, isAbsolute, relative, resolve } from 'node:path'
import { realpathSync } from 'node:fs'

export class ShellPolicyError extends Error {}
const refuse = (message = 'command is outside the public shell policy') => new ShellPolicyError(message)

/** Split a display-oriented command the way the broker does: no shell syntax, POSIX quoting only. */
export function parseCommand(command) {
  if (typeof command !== 'string' || !command.trim() || SHELL_SYNTAX.test(command)) {
    throw refuse('command must be one allowlisted executable invocation')
  }
  const args = []
  let current = ''
  let quote = null
  let hasToken = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote === "'") {
      if (ch === "'") quote = null
      else current += ch
    } else if (quote === '"') {
      if (ch === '"') quote = null
      else if (ch === '\\' && i + 1 < command.length && '"\\$`'.includes(command[i + 1])) current += command[++i]
      else current += ch
    } else if (ch === "'" || ch === '"') {
      quote = ch
      hasToken = true
    } else if (ch === '\\' && i + 1 < command.length) {
      current += command[++i]
      hasToken = true
    } else if (/\s/.test(ch)) {
      if (hasToken) args.push(current)
      current = ''
      hasToken = false
    } else {
      current += ch
      hasToken = true
    }
  }
  if (quote !== null) throw refuse('command quoting is invalid')
  if (hasToken) args.push(current)
  return args
}

function isRemoteHelperForm(value) { return REMOTE_HELPER.test(value) }
function isScpRemoteForm(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || /\s/.test(value) || value.includes('://') || WINDOWS_PATH.test(value)) return false
  return SCP_REMOTE.test(value)
}
function isPublicRemoteUrl(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || /\s/.test(value)) return false
  if (isRemoteHelperForm(value)) return false
  const scp = isScpRemoteForm(value) ? SCP_REMOTE.exec(value) : null
  if (scp) {
    const { user, host } = scp.groups
    return !(user && user.startsWith('-')) && !host.startsWith('-')
  }
  let parsed
  try { parsed = new URL(value) } catch { return false }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase()
  return ['http', 'https', 'ssh'].includes(scheme) && Boolean(parsed.host) && Boolean(parsed.hostname) &&
    !parsed.hostname.startsWith('-') && !(parsed.username || '').startsWith('-')
}

function workspaceOperand(value, workspaceRoot) {
  if (!value || value.includes('\0') || value.includes('://') || isRemoteHelperForm(value) || isScpRemoteForm(value)) throw refuse()
  if (workspaceRoot === null) {
    if (value.startsWith('/') || value.startsWith('\\') || WINDOWS_PATH.test(value)) throw refuse()
    if (value.split(/[\\/]/).includes('..')) throw refuse()
    return
  }
  const root = realpathOrResolve(workspaceRoot)
  const expanded = value.startsWith('~/') ? resolve(process.env.HOME ?? '', value.slice(2)) : value
  const target = realpathOrResolve(isAbsolute(expanded) ? expanded : resolve(root, expanded))
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) throw refuse()
}

function realpathOrResolve(path) {
  try { return realpathSync(path) } catch { return resolve(path) }
}

function optionMatches(arg, option) { return arg === option || arg.startsWith(`${option}=`) }

function commandIndex(args, executable) {
  let index = 1
  while (index < args.length) {
    const arg = args[index]
    if (arg === '--') throw refuse()
    if (executable === 'git' && ['--no-pager', '--paginate', '--no-replace-objects', '--literal-pathspecs'].includes(arg)) { index++; continue }
    if (arg.startsWith('-')) throw refuse()
    return index
  }
  throw refuse()
}

function validateGitOptions(command, args, workspaceRoot) {
  const positionals = []
  let afterDoubleDash = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (afterDoubleDash) { positionals.push(arg); continue }
    if (arg === '--') { afterDoubleDash = true; continue }
    if (!arg.startsWith('-') || arg === '-') { positionals.push(arg); continue }
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg : arg.slice(0, eq)
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1)
    if (PUBLIC_GIT_OVERRIDE_OPTIONS.some((option) => optionMatches(arg, option))) throw refuse()
    if (arg.startsWith('-c') || arg.startsWith('-C')) throw refuse()
    if (command === 'log' && /^-\d+$/.test(arg)) continue
    if (PUBLIC_GIT_BOOLEAN_OPTIONS.has(name)) {
      if (inlineValue !== undefined) throw refuse()
      continue
    }
    if (PUBLIC_GIT_VALUE_OPTIONS.has(name) || PUBLIC_GIT_PATH_VALUE_OPTIONS.has(name)) {
      let value
      if (inlineValue !== undefined) value = inlineValue
      else {
        if (index + 1 >= args.length) throw refuse()
        value = args[++index]
      }
      if (PUBLIC_GIT_PATH_VALUE_OPTIONS.has(name)) workspaceOperand(value, workspaceRoot)
      else if (!value || value.includes('\0')) throw refuse()
      continue
    }
    throw refuse()
  }
  return positionals
}

function validateRemoteOperand(value, workspaceRoot) {
  if (isRemoteHelperForm(value)) throw refuse()
  if (isPublicRemoteUrl(value)) return
  workspaceOperand(value, workspaceRoot)
}

function validateGitCommand(command, commandArgs, workspaceRoot) {
  const positionals = validateGitOptions(command, commandArgs, workspaceRoot)
  if (command === 'clone') {
    if (![1, 2].includes(positionals.length)) throw refuse()
    validateRemoteOperand(positionals[0], workspaceRoot)
    if (positionals.length === 2) workspaceOperand(positionals[1], workspaceRoot)
    return
  }
  if (command === 'worktree') {
    if (positionals[0] !== 'add' || positionals.length < 2) throw refuse()
    for (const value of positionals.slice(1)) workspaceOperand(value, workspaceRoot)
    return
  }
  if (command === 'remote') {
    if (positionals.length === 0) return
    if (['add', 'set-url'].includes(positionals[0])) {
      if (positionals.length !== 3) throw refuse()
      workspaceOperand(positionals[1], workspaceRoot)
      validateRemoteOperand(positionals[2], workspaceRoot)
      return
    }
    for (const value of positionals) workspaceOperand(value, workspaceRoot)
    return
  }
  if (['fetch', 'pull', 'push'].includes(command) && positionals.length > 0) {
    const [first, ...rest] = positionals
    if (isRemoteHelperForm(first)) throw refuse()
    if (!isPublicRemoteUrl(first)) workspaceOperand(first, workspaceRoot)
    for (const value of rest) workspaceOperand(value, workspaceRoot)
    return
  }
  if (command === 'init' && positionals.length > 1) throw refuse()
  for (const value of positionals) workspaceOperand(value, workspaceRoot)
}

function validateProviderCommand(executable, command, commandArgs, workspaceRoot) {
  if (commandArgs.some((value) => PUBLIC_PROVIDER_FORBIDDEN_NESTED.has(value.toLowerCase()))) throw refuse()
  if (command === 'api') {
    if (commandArgs.length === 0 || commandArgs.some((value) => value.startsWith('-'))) throw refuse()
    if (commandArgs.some((value) => value.includes('://') || isRemoteHelperForm(value))) throw refuse()
    return
  }
  const subcommands = PUBLIC_PROVIDER_SUBCOMMANDS[executable][command]
  if (subcommands === undefined) {
    if (commandArgs.length > 0) throw refuse()
    return
  }
  if (commandArgs.length === 0 || !subcommands.has(commandArgs[0])) throw refuse()
  for (let index = 1; index < commandArgs.length; index++) {
    const arg = commandArgs[index]
    if (arg === '--') throw refuse()
    if (!arg.startsWith('-')) {
      if (arg.includes('://') || isRemoteHelperForm(arg)) throw refuse()
      continue
    }
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg : arg.slice(0, eq)
    if (name === '--input' || (!PUBLIC_PROVIDER_VALUE_OPTIONS.has(name) && !PUBLIC_PROVIDER_BOOLEAN_OPTIONS.has(name))) throw refuse()
    if (PUBLIC_PROVIDER_BOOLEAN_OPTIONS.has(name)) {
      if (eq !== -1) throw refuse()
      continue
    }
    let value
    if (eq !== -1) value = arg.slice(eq + 1)
    else {
      if (index + 1 >= commandArgs.length) throw refuse()
      value = commandArgs[++index]
    }
    if (!value || value.includes('\0')) throw refuse()
    if (name === '--output') workspaceOperand(value, workspaceRoot)
  }
}

/** host_shell.declared_executables: the names a package may declare (C2). */
export function declaredExecutables(value) {
  const names = new Set()
  for (const name of Array.isArray(value) ? value : []) {
    if (typeof name !== 'string' || !DECLARED_EXECUTABLE.test(name) || DECLARED_EXTENSION.test(name) || HOST_SHELL_EXECUTABLE_ALLOWLIST.has(name)) continue
    names.add(name)
    if (names.size >= 32) break
  }
  return names
}

/** host_shell.validate_public_argv: the argv of a Manifest v2 public shell.run. */
export function validatePublicArgv(args, { workspaceRoot = null, allowedExecutables = new Set() } = {}) {
  if (!Array.isArray(args) || args.length === 0 || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw refuse('command arguments must be non-empty strings')
  }
  const executable = args[0]
  if (executable !== basename(executable) || (!HOST_SHELL_EXECUTABLE_ALLOWLIST.has(executable) && !allowedExecutables.has(executable))) {
    throw refuse(allowedExecutables.size > 0 ? 'executable is not allowlisted or declared' : 'executable is not allowlisted')
  }
  if (!HOST_SHELL_EXECUTABLE_ALLOWLIST.has(executable)) return [...args]
  const index = commandIndex(args, executable)
  const command = args[index]
  const commandArgs = args.slice(index + 1)
  if (executable === 'git') {
    if (!PUBLIC_GIT_COMMANDS.has(command)) throw refuse()
    if (['credential', 'config', 'difftool', 'filter-branch', 'hook', 'mergetool', 'send-email'].includes(command)) throw refuse()
    if (command === 'submodule' && commandArgs[0] !== 'status') throw refuse()
    if (command === 'bisect' && commandArgs[0] === 'run') throw refuse()
    validateGitCommand(command, commandArgs, workspaceRoot)
    return [...args]
  }
  const allowed = executable === 'gh' ? PUBLIC_GH_COMMANDS : PUBLIC_GLAB_COMMANDS
  if (!allowed.has(command)) throw refuse()
  validateProviderCommand(executable, command, commandArgs, workspaceRoot)
  return [...args]
}
