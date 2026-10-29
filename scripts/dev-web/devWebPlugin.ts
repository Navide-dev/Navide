// Dev-only web mode: open the dev renderer's main window in a normal (or
// headless) browser. Wired into electron.vite.config.ts and active only when
// the dev server is started with NAVIDE_DEV_WEB=1 — `apply: 'serve'` keeps it
// out of every build, and scripts/check-no-dev-web.mjs proves that on out/.
//
// What it adds to the dev server, bound to 127.0.0.1 only:
// - /__navide_dev_web/mint   (POST, x-electron-token = the dev token from
//   devTokenFile(): $TMPDIR/agent-team-dev-token, or
//   $TMPDIR/agent-team-dev-token-<port> off the default port) → a one-time login code
// - /__navide_dev_web/login?code=… → a host-only HttpOnly session cookie
// - a session cookie stands in for the x-electron-token header, so the
//   existing electron-only gate still answers 403 to everyone else
// - /__navide_dev_web/backend and /prove → what preload's getBackendInfo and
//   proveWindow would return, for the shim in src/renderer/src/devWeb/
//
// The backend is an ISOLATED one by default: its own data dir, HOME and port
// (8931), so it never touches the dev or installed app's data. Set
// NAVIDE_DEV_WEB_BACKEND=dev to talk to the dev Electron's backend instead.
import type { Connect, Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export const DEV_WEB_PREFIX = '/__navide_dev_web/'
const COOKIE = 'navide_dev_web'
const SHIM_SRC = '/src/devWeb/devWebShim.ts'
const DEFAULT_PORT = 5274
const DEFAULT_BACKEND_PORT = 8931
const CODE_TTL_MS = 120_000

export interface DevWebBackendInfo {
  status: 'starting' | 'ready' | 'error'
  host?: string
  port?: number
  pid?: number
  httpUrl?: string
  wsUrl?: string
  error?: string
}

export interface DevWebBackend {
  info(): DevWebBackendInfo
  /** The window-challenge answer main would give; null when this backend's host token is unknown. */
  prove(nonce: string): string | null
}

function sameSecret(a: unknown, b: string): boolean {
  if (typeof a !== 'string' || !a || !b) return false
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function forbid(res: ServerResponse): void {
  res.writeHead(403, { 'Content-Type': 'text/plain' })
  res.end('403 Forbidden')
}

async function readBody(req: IncomingMessage): Promise<string> {
  let text = ''
  for await (const chunk of req) {
    text += String(chunk)
    if (text.length > 4096) break
  }
  return text
}

export function createDevWebGate(opts: {
  devToken: string
  allowedHost: string
  backend: DevWebBackend
}): Connect.NextHandleFunction & { mintCode(): string } {
  const codes = new Map<string, number>()
  const sessions = new Set<string>()

  const mintCode = (): string => {
    const code = randomBytes(24).toString('hex')
    codes.set(code, Date.now() + CODE_TTL_MS)
    return code
  }

  const sessionOf = (req: IncomingMessage): boolean => {
    for (const part of String(req.headers.cookie ?? '').split(';')) {
      const [k, v] = part.trim().split('=')
      if (k === COOKIE && v && sessions.has(v)) return true
    }
    return false
  }

  const gate = ((req, res, next) => {
    // DNS rebinding: a page on another name resolving to 127.0.0.1 must not
    // ride the cookie. Only the exact bound address is ours.
    if (req.headers.host !== opts.allowedHost) return forbid(res)
    const url = new URL(req.url ?? '/', `http://${opts.allowedHost}`)
    const inSession = sessionOf(req)

    if (url.pathname.startsWith(DEV_WEB_PREFIX)) {
      const route = url.pathname.slice(DEV_WEB_PREFIX.length)
      if (route === 'mint' && req.method === 'POST') {
        if (!sameSecret(req.headers['x-electron-token'], opts.devToken)) return forbid(res)
        const code = mintCode()
        return sendJson(res, 200, { code, loginPath: `${DEV_WEB_PREFIX}login?code=${code}` })
      }
      if (route === 'login') {
        const code = url.searchParams.get('code') ?? ''
        const expires = codes.get(code)
        codes.delete(code)
        if (!expires || expires < Date.now()) return forbid(res)
        const session = randomBytes(32).toString('hex')
        sessions.add(session)
        // No Domain attribute: host-only, so it goes to 127.0.0.1 and nowhere else.
        res.writeHead(302, {
          'Set-Cookie': `${COOKIE}=${session}; Path=/; HttpOnly; SameSite=Strict`,
          Location: '/',
        })
        return res.end()
      }
      if (!inSession) return forbid(res)
      if (route === 'backend') return sendJson(res, 200, opts.backend.info())
      if (route === 'prove' && req.method === 'POST') {
        void readBody(req).then((text) => {
          let nonce = ''
          try {
            const parsed = JSON.parse(text) as { nonce?: unknown }
            if (typeof parsed.nonce === 'string') nonce = parsed.nonce
          } catch {
            // fall through with no nonce
          }
          sendJson(res, 200, { proof: nonce ? opts.backend.prove(nonce) : null })
        })
        return
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      return res.end('404 Not Found')
    }

    // A session stands in for Electron's injected header; the electron-only
    // gate after this one keeps refusing everything else.
    if (inSession) req.headers['x-electron-token'] = opts.devToken
    next()
  }) as Connect.NextHandleFunction & { mintCode(): string }
  gate.mintCode = mintCode
  return gate
}

function readTrimmed(path: string): string {
  try {
    return readFileSync(path, 'utf-8').trim()
  } catch {
    return ''
  }
}

function infoFromDataDir(dataDir: string, port: number, pid?: number): DevWebBackendInfo {
  const token = readTrimmed(join(dataDir, 'backend-ws-token'))
  if (!token || !port) return { status: 'starting' }
  return {
    status: 'ready',
    host: '127.0.0.1',
    port,
    pid,
    httpUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws?t=${encodeURIComponent(token)}`,
  }
}

/** The dev Electron's own backend (NAVIDE_DEV_WEB_BACKEND=dev): read-only, no window proof. */
function attachedBackend(env: NodeJS.ProcessEnv): DevWebBackend {
  const appData =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : process.platform === 'win32'
        ? (env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
        : (env.XDG_CONFIG_HOME ?? join(homedir(), '.config'))
  const dataDir = env.NAVIDE_DEV_WEB_ATTACH_DIR || join(appData, 'Agent-Team-dev')
  console.log(`[navide-dev-web] attached to the dev backend in ${dataDir}`)
  return {
    info: () => infoFromDataDir(dataDir, Number(readTrimmed(join(dataDir, 'backend-port')))),
    prove: () => null,
  }
}

/**
 * Create `dir` owner-only, or accept it only if it already is: a real
 * directory (not a symlink) owned by this user with no group/other access.
 * The default lives under tmpdir(), which is shared /tmp on Linux, and its
 * bin/ goes first on the backend's PATH — a dir someone else made first
 * would let them plant executables there.
 */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const st = lstatSync(dir)
  const mine = typeof process.getuid !== 'function' || st.uid === process.getuid()
  if (!st.isDirectory() || st.isSymbolicLink() || !mine || (process.platform !== 'win32' && (st.mode & 0o077) !== 0)) {
    throw new Error(`[navide-dev-web] run dir is not private (must be a 0700 directory you own): ${dir}`)
  }
}

/** A backend of its own: separate data dir, HOME, TMPDIR and port; no reach to the real keychain. */
function isolatedBackend(env: NodeJS.ProcessEnv, repoRoot: string): DevWebBackend & { stop(): void } {
  const port = Number(env.NAVIDE_DEV_WEB_BACKEND_PORT) || DEFAULT_BACKEND_PORT
  const runDir = env.NAVIDE_DEV_WEB_DIR || join(tmpdir(), 'navide-dev-web')
  const dataDir = join(runDir, 'data')
  const home = join(runDir, 'home')
  const tmp = join(runDir, 'tmp')
  const bin = join(runDir, 'bin')
  ensurePrivateDir(runDir)
  for (const d of [dataDir, home, tmp, bin]) mkdirSync(d, { recursive: true })
  const isWin = process.platform === 'win32'
  const venvBin = join(repoRoot, 'backend', '.venv', isWin ? 'Scripts' : 'bin')
  const python = join(venvBin, isWin ? 'python.exe' : 'python')
  const hostToken = randomBytes(32).toString('hex')
  let child: ChildProcess | null = null
  let failure = ''

  if (!existsSync(python)) {
    failure = `no backend venv at ${python}`
    console.error(`[navide-dev-web] ${failure}`)
  } else {
    // Anything that reaches for the macOS keychain gets "not found" instead.
    if (!isWin) writeFileSync(join(bin, 'security'), '#!/bin/sh\nexit 44\n', { mode: 0o755 })
    // A stale token from an earlier run must not read as "ready".
    writeFileSync(join(dataDir, 'backend-ws-token'), '')
    const childEnv: NodeJS.ProcessEnv = {
      ...(isWin ? process.env : { LANG: env.LANG ?? 'en_US.UTF-8', USER: env.USER ?? '' }),
      HOME: home,
      USERPROFILE: home,
      TMPDIR: tmp,
      AGENT_TEAM_DATA_DIR: dataDir,
      // Home lookups that bypass $HOME (the passwd entry) use HOME here instead.
      AGENT_TEAM_ISOLATED_HOME: '1',
      AGENT_TEAM_PARENT_PID: String(process.pid),
      PYTHONPATH: join(repoRoot, 'backend'),
      PATH: [bin, venvBin, ...(isWin ? [env.PATH ?? ''] : ['/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(isWin ? ';' : ':'),
    }
    const args = ['-m', 'agent_team_backend', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning']
    // macOS: also deny exec of the real `security`, whatever PATH a child builds.
    const [cmd, argv] =
      process.platform === 'darwin'
        ? ['/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)(deny process-exec (literal "/usr/bin/security"))', python, ...args]]
        : [python, args]
    child = spawn(cmd, argv, { cwd: runDir, env: childEnv, stdio: ['pipe', 'inherit', 'inherit'] })
    child.stdin?.write(`${randomBytes(32).toString('hex')} ${hostToken}\n`)
    if (!isWin) child.stdin?.end()
    child.on('exit', (code, signal) => {
      failure = `backend exited (${signal ?? code})`
      console.error(`[navide-dev-web] ${failure}`)
      child = null
    })
    writeFileSync(join(runDir, 'backend.pid'), String(child.pid ?? ''))
    console.log(`[navide-dev-web] isolated backend pid ${child.pid} on 127.0.0.1:${port}, data ${dataDir}`)
  }

  return {
    info: () => (failure ? { status: 'error', error: failure } : infoFromDataDir(dataDir, port, child?.pid)),
    prove: (nonce) =>
      createHmac('sha256', hostToken).update(`navide-window/v2\0${nonce}`).digest('hex'),
    stop: () => {
      if (child?.pid) child.kill('SIGTERM')
    },
  }
}

/**
 * Where this dev server writes its dev token (the x-electron-token secret).
 * The Electron dev server and a dev web server on the default port keep the
 * shared name main reads; a dev web server on any other port gets a file of
 * its own, so two of them sharing one $TMPDIR cannot overwrite each other.
 */
export function devTokenFile(env: NodeJS.ProcessEnv = process.env, dir = tmpdir()): string {
  const port = Number(env.NAVIDE_DEV_WEB_PORT) || DEFAULT_PORT
  const own = env.NAVIDE_DEV_WEB === '1' && port !== DEFAULT_PORT
  return join(dir, own ? `agent-team-dev-token-${port}` : 'agent-team-dev-token')
}

/** The dev web plugin, or nothing at all unless NAVIDE_DEV_WEB is exactly "1". */
export function devWebPlugins(devToken: string, env: NodeJS.ProcessEnv = process.env, repoRoot = process.cwd()): Plugin[] {
  if (env.NAVIDE_DEV_WEB !== '1') return []
  const port = Number(env.NAVIDE_DEV_WEB_PORT) || DEFAULT_PORT
  return [
    {
      name: 'navide-dev-web',
      apply: 'serve',
      config: () => ({ server: { host: '127.0.0.1', port, strictPort: true } }),
      configureServer(server) {
        const backend = env.NAVIDE_DEV_WEB_BACKEND === 'dev' ? attachedBackend(env) : isolatedBackend(env, repoRoot)
        const gate = createDevWebGate({ devToken, allowedHost: `127.0.0.1:${port}`, backend })
        server.middlewares.use(gate)
        const stop = (): void => {
          if ('stop' in backend) (backend as { stop(): void }).stop()
        }
        server.httpServer?.once('close', stop)
        process.once('exit', stop)
        server.httpServer?.once('listening', () => {
          console.log(`[navide-dev-web] one-time login: http://127.0.0.1:${port}${DEV_WEB_PREFIX}login?code=${gate.mintCode()}`)
          console.log(`[navide-dev-web] dev token file: ${devTokenFile(env)}`)
        })
      },
      transformIndexHtml: () => [{ tag: 'script', attrs: { type: 'module', src: SHIM_SRC }, injectTo: 'head-prepend' }],
    },
  ]
}
