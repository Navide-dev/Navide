// `navide-plugin dev-backend`: run a plugin's backend locally under the same
// OS sandbox Navide uses for third-party backends, and talk Backend Wire v1 to
// it on stdio, so an author can exercise methods and events before publishing.
//
// The sandbox profile and bubblewrap arguments below must stay identical to
// src/main/plugins/pluginBackendSandbox.ts (a parity test enforces it). The
// Host bridge is not emulated: every `navide/host/call` from the backend is
// printed and refused with CAPABILITY_DENIED.

import { spawn, spawnSync } from 'node:child_process'
import { accessSync, constants, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join, posix, resolve } from 'node:path'
import { createInterface } from 'node:readline'

const PROTOCOL_REVISION = '2026-07-28'
const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec'
const BWRAP_CANDIDATES = ['/usr/bin/bwrap', '/bin/bwrap']
const REQUEST_TIMEOUT_MS = 30_000

function assertSandboxPath(path) {
  if (!path.startsWith('/') || /[\0-\x1f\x7f]/.test(path)) {
    throw new Error('sandbox path must be absolute and free of control characters')
  }
}

function sbplString(value) {
  assertSandboxPath(value)
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Must match SENSITIVE_HOME_ENTRIES in pluginBackendSandbox.ts. */
const SENSITIVE_HOME_ENTRIES = [
  '.ssh', '.aws', '.gnupg', '.config', '.kube', '.docker', '.netrc', '.claude', '.codex',
  'Library/Keychains', 'Documents', 'Downloads',
]

function sensitiveMetadataDenial(homeDir) {
  if (!homeDir) return []
  const targets = SENSITIVE_HOME_ENTRIES.map((entry) => `(subpath ${sbplString(`${homeDir}/${entry}`)})`)
  return [`(deny file-read-metadata ${targets.join(' ')})`]
}

export function buildSeatbeltProfile(paths) {
  const pkg = sbplString(paths.packageDir)
  const data = sbplString(paths.dataDir)
  return [
    '(version 1)',
    '(deny default)',
    '(import "bsd.sb")',
    ...sensitiveMetadataDenial(paths.homeDir),
    '(allow process-fork)',
    `(allow process-exec (subpath ${pkg}))`,
    `(allow file-read* (subpath ${pkg}) (subpath ${data}))`,
    `(allow file-write* (subpath ${data}))`,
    `(allow file-map-executable (subpath ${pkg}) (subpath ${data}))`,
    '(allow ipc-sysv-sem)',
    '',
  ].join('\n')
}

export function buildBubblewrapArgs(paths) {
  assertSandboxPath(paths.packageDir)
  assertSandboxPath(paths.dataDir)
  assertSandboxPath(paths.entryFile)
  return [
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind-try', '/lib', '/lib',
    '--ro-bind-try', '/lib64', '/lib64',
    '--ro-bind-try', '/bin', '/bin',
    '--ro-bind-try', '/etc/ld.so.cache', '/etc/ld.so.cache',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--ro-bind', paths.packageDir, paths.packageDir,
    '--bind', paths.dataDir, paths.dataDir,
    '--chdir', paths.dataDir,
  ]
}

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function findBubblewrap() {
  for (const candidate of BWRAP_CANDIDATES) {
    if (!isExecutable(candidate)) continue
    const probe = spawnSync(candidate, ['--unshare-all', '--die-with-parent', '--ro-bind', '/', '/', 'true'], {
      stdio: 'ignore',
      timeout: 5_000,
    })
    if (probe.status === 0) return candidate
  }
  return null
}

/** The sandboxed command for this platform, or an Error explaining why the
 * backend cannot run here. There is no unsandboxed mode. */
export function resolveDevSandbox(paths, platform = process.platform, probe = {}) {
  if (platform === 'darwin') {
    const sandboxExec = probe.sandboxExec !== undefined
      ? probe.sandboxExec
      : isExecutable(SANDBOX_EXEC_PATH) ? SANDBOX_EXEC_PATH : null
    if (!sandboxExec) return new Error('macOS sandbox-exec is unavailable; refusing to run the backend unsandboxed')
    return { command: sandboxExec, args: ['-p', buildSeatbeltProfile(paths), paths.entryFile] }
  }
  if (platform === 'linux') {
    const bwrap = probe.bubblewrap !== undefined ? probe.bubblewrap : findBubblewrap()
    if (!bwrap) {
      return new Error(
        'bubblewrap (bwrap) is not installed or unprivileged user namespaces are disabled; ' +
        'Navide will not run third-party backends on this host, so dev-backend refuses too',
      )
    }
    return { command: bwrap, args: [...buildBubblewrapArgs(paths), '--', paths.entryFile] }
  }
  if (platform === 'win32') {
    return new Error('third-party backends are not supported on Windows yet (planned for v1.1)')
  }
  return new Error(`no backend sandbox for platform ${platform}`)
}

/**
 * macOS: kill sandboxed processes that escaped to launchd (fork -> setsid ->
 * fork). The sandbox lets a process exec only files of its own package, so an
 * escapee has a package executable's kernel name and maps its image from the
 * package; lsof confirms it. Same rule as the Host (pluginBackendResourceWatchdog.ts).
 */
export function killEscapedProcesses(packageDir, dataDir) {
  if (process.platform !== 'darwin') return []
  const names = new Set()
  const pending = [packageDir]
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile() && (lstatSync(path).mode & 0o111) !== 0) names.add(basename(path).slice(0, 16))
    }
  }
  const listing = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,ucomm='], { encoding: 'utf8' }).stdout ?? ''
  const rows = listing.split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line)).filter(Boolean)
    .map(([, pid, ppid, name]) => ({ pid: Number(pid), ppid: Number(ppid), name: name.trim() }))
  const candidates = rows.filter((row) => row.ppid === 1 && names.has(row.name)).map((row) => row.pid)
  if (candidates.length === 0) return []
  const lsof = spawnSync('lsof', ['-nP', '-w', '-a', '-p', candidates.join(','), '-d', 'txt', '-Fpn'], { encoding: 'utf8' }).stdout ?? ''
  const escaped = new Set()
  let current = null
  for (const line of lsof.split('\n')) {
    if (line.startsWith('p')) current = Number(line.slice(1))
    else if (line.startsWith('n') && current !== null &&
      (line.startsWith(`n${packageDir}/`) || line.startsWith(`n${dataDir}/`))) escaped.add(current)
  }
  const victims = [...escaped]
  for (let index = 0; index < victims.length; index += 1) {
    for (const row of rows) if (row.ppid === victims[index] && !victims.includes(row.pid)) victims.push(row.pid)
  }
  for (const pid of victims.reverse()) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  return victims
}

function backendEntryForTarget(entry) {
  return process.platform === 'win32' && posix.extname(entry) === '' ? `${entry}.exe` : entry
}

function meta() {
  return {
    'io.modelcontextprotocol/protocolVersion': PROTOCOL_REVISION,
    'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': { name: 'navide-plugin dev-backend', version: '1.0.0' },
  }
}

/**
 * Start the backend of the plugin in `directory` under the sandbox.
 * Returns a session with `call`, `subscribe` and `close`; every frame the
 * backend sends is reported through `onOutput(kind, detail)`.
 */
export async function startDevBackend({ directory, manifest, dataDir, onOutput, platform, probe }) {
  if (!manifest.backend) throw new Error(`${manifest.id} has no backend`)
  const packageDir = realpathSync(directory)
  const entryFile = realpathSync(join(packageDir, backendEntryForTarget(manifest.backend.entry)))
  if (!entryFile.startsWith(`${packageDir}/`)) throw new Error('backend entry resolves outside the plugin directory')
  if (!isExecutable(entryFile)) throw new Error(`backend entry is not executable: ${entryFile}`)
  mkdirSync(join(dataDir, 'tmp'), { recursive: true, mode: 0o700 })
  const canonicalDataDir = realpathSync(dataDir)
  const paths = { packageDir, dataDir: canonicalDataDir, entryFile }
  const sandbox = resolveDevSandbox(paths, platform, probe)
  if (sandbox instanceof Error) throw sandbox
  // Leftovers that escaped an earlier run are removed before a new one starts.
  killEscapedProcesses(packageDir, canonicalDataDir)

  const tmp = `${canonicalDataDir}/tmp`
  const child = spawn(sandbox.command, sandbox.args, {
    cwd: canonicalDataDir,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: '/usr/bin:/bin',
      HOME: canonicalDataDir,
      TMPDIR: `${tmp}/`,
      TMP: tmp,
      TEMP: tmp,
      XDG_CACHE_HOME: `${canonicalDataDir}/cache`,
      XDG_CONFIG_HOME: `${canonicalDataDir}/config`,
      XDG_DATA_HOME: `${canonicalDataDir}/share`,
    },
  })
  const runtime = {
    pluginId: manifest.id,
    packageVersion: manifest.version,
    workspaceId: 'dev-workspace',
    instanceId: 'dev-backend',
    contributionKey: `${manifest.id}.dev`,
    hostWindowId: 'dev',
    initiator: { kind: 'user', id: 'dev' },
  }
  const pending = new Map()
  let nextId = 1
  let exited = null
  const exit = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      exited = { code, signal }
      for (const { reject, timer } of pending.values()) {
        clearTimeout(timer)
        reject(new Error(`backend exited (${signal ?? code})`))
      }
      pending.clear()
      onOutput('exit', exited)
      resolve(exited)
    })
  })
  child.on('exit', () => killEscapedProcesses(packageDir, canonicalDataDir))
  child.on('error', (error) => onOutput('error', error.message))
  createInterface({ input: child.stderr }).on('line', (line) => onOutput('stderr', line))
  createInterface({ input: child.stdout }).on('line', (line) => {
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      onOutput('protocol-error', `stdout carried a non-JSON line: ${line}`)
      return
    }
    if (frame.method === 'navide/host/call') {
      onOutput('bridge', { port: frame.params?.port, operation: frame.params?.operation, arguments: frame.params?.arguments })
      write({ jsonrpc: '2.0', id: frame.id, error: { code: 1000, message: 'Host Bridge request failed.', data: { code: 'CAPABILITY_DENIED' } } })
      return
    }
    if (frame.method === 'notifications/navide/event') {
      onOutput('event', { event: frame.params?.event, payload: frame.params?.payload })
      return
    }
    if (frame.method === 'notifications/subscriptions/acknowledged') {
      const waiter = pending.get(frame.params?._meta?.['io.modelcontextprotocol/subscriptionId'])
      if (waiter?.subscription) {
        pending.delete(waiter.id)
        clearTimeout(waiter.timer)
        waiter.resolve(frame.params?.notifications?.['dev.navide/pluginEvents'] ?? [])
      }
      return
    }
    if (typeof frame.method === 'string') {
      onOutput('notification', frame)
      return
    }
    const waiter = pending.get(frame.id)
    if (!waiter) {
      onOutput('protocol-error', `response for an unknown request id: ${line}`)
      return
    }
    pending.delete(frame.id)
    clearTimeout(waiter.timer)
    if (frame.error) waiter.reject(Object.assign(new Error(frame.error.message), { data: frame.error.data }))
    else waiter.resolve(frame.result?.value ?? null)
  })

  function write(frame) {
    if (exited || child.stdin.destroyed) return
    child.stdin.write(`${JSON.stringify(frame)}\n`)
  }

  function request(method, params, options = {}) {
    if (exited) return Promise.reject(new Error('backend is not running'))
    const id = `dev-${nextId++}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${method} timed out after ${REQUEST_TIMEOUT_MS} ms`))
      }, REQUEST_TIMEOUT_MS)
      pending.set(id, { id, resolve, reject, timer, subscription: options.subscription === true })
      write({ jsonrpc: '2.0', id, method, params: { _meta: meta(), ...params } })
    })
  }

  const methods = manifest.backend.methods ?? []
  const events = manifest.backend.events ?? []
  const session = {
    health: () => request('navide/health', {}),
    call(name, args = {}) {
      // Navide forwards only declared methods; refuse the same way here.
      if (!methods.includes(name)) {
        return Promise.reject(new Error(`'${name}' is not declared in backend.methods (${methods.join(', ') || 'none'})`))
      }
      return request('navide/call', { name, arguments: args, runtime })
    },
    subscribe(event) {
      if (!events.includes(event)) {
        return Promise.reject(new Error(`'${event}' is not declared in backend.events (${events.join(', ') || 'none'})`))
      }
      return request(
        'subscriptions/listen',
        { notifications: { 'dev.navide/pluginEvents': [event] }, runtime },
        { subscription: true },
      )
    },
    async close() {
      if (!exited) child.stdin.end()
      const timer = setTimeout(() => {
        if (!exited) child.kill('SIGKILL')
      }, 2_000)
      await exit
      clearTimeout(timer)
    },
    exit,
    sandbox: sandbox.command,
  }
  await session.health()
  return session
}

/** One line of dev-backend output; a clean exit (code 0) gets no failure cross. */
export function formatOutput(kind, detail) {
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail)
  const cleanExit = kind === 'exit' && detail?.code === 0 && !detail?.signal
  const prefix = {
    result: '← result',
    event: '← event',
    bridge: '← bridge (denied in dev-backend)',
    stderr: '[backend]',
    exit: cleanExit ? '• backend exited' : '× backend exited',
    error: '× error',
    'protocol-error': '× protocol',
    notification: '← notification',
  }[kind] ?? kind
  return `${prefix} ${text}`
}

function print(kind, detail) {
  ;(kind === 'stderr' || kind === 'error' || kind === 'protocol-error' ? console.error : console.log)(formatOutput(kind, detail))
}

/** Where dev-backend keeps a package's data by default: beside the package
 *  directory, never inside it, so a build that lists the directory recursively
 *  cannot package it. */
export function defaultDataDir(directory) {
  const packageDir = resolve(directory)
  return join(dirname(packageDir), '.navide-dev', basename(packageDir), 'data')
}

function parseJsonArgument(text, label) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${label} must be JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** CLI entry: one-shot (`--call`) or interactive (lines `<method> [json]`). */
export async function runDevBackend(directory, manifest, options) {
  const dataDir = options.dataDir ?? defaultDataDir(directory)
  const session = await startDevBackend({ directory, manifest, dataDir, onOutput: print })
  console.log(`Backend ${manifest.id}@${manifest.version} is running in the ${session.sandbox} sandbox (data: ${dataDir}).`)
  for (const event of options.subscribe ?? []) {
    await session.subscribe(event)
    console.log(`Subscribed to ${event}.`)
  }
  if (options.call) {
    let failed = false
    try {
      print('result', await session.call(options.call, options.args ? parseJsonArgument(options.args, '--args') : {}))
    } catch (error) {
      failed = true
      print('error', error.data ? `${error.message} ${JSON.stringify(error.data)}` : error.message)
    }
    await session.close()
    return failed ? 1 : 0
  }
  console.log('Type `<method> [json arguments]`, `:subscribe <event>` or `:quit`.')
  const input = createInterface({ input: process.stdin })
  for await (const line of input) {
    const text = line.trim()
    if (!text) continue
    if (text === ':quit') break
    const [head, ...rest] = text.split(/\s+/)
    try {
      if (head === ':subscribe') {
        await session.subscribe(rest[0] ?? '')
        console.log(`Subscribed to ${rest[0]}.`)
      } else {
        print('result', await session.call(head, rest.length ? parseJsonArgument(rest.join(' '), 'arguments') : {}))
      }
    } catch (error) {
      print('error', error.data ? `${error.message} ${JSON.stringify(error.data)}` : error.message)
    }
  }
  input.close()
  await session.close()
  return 0
}
