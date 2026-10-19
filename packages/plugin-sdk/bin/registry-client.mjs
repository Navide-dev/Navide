// Registry side of `navide-plugin`: browser login, stored credentials and
// publish. Wire-compatible with the Registry (marketplace/registry) and with
// the legacy Python CLI (marketplace/registry/registry/cli.py): both read and
// write the same credentials file, so a login from either works for both.

import { spawn } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, openSync, closeSync, writeSync, chmodSync, readFileSync, renameSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { readRegularFileNoFollow } from './package-files.mjs'

export const OFFICIAL_REGISTRY = 'https://server.navide.dev/registry'
export const TOKEN_ENV = 'NAVIDE_PLUGIN_TOKEN'
export const REGISTRY_ENV = 'NAVIDE_REGISTRY_URL'
const CONFIG_DIR_ENV = 'NAVIDE_PLUGIN_CONFIG_DIR'
const LOGIN_TIMEOUT_MS = 300_000

/** --registry, then NAVIDE_REGISTRY_URL, then the Official Registry. */
export function registryUrl(option) {
  return (option || process.env[REGISTRY_ENV] || OFFICIAL_REGISTRY).replace(/\/+$/, '')
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** A token only travels over https, or plain http to a loopback Registry.
 *  `insecureHttp` lets local development reach another plain-http host,
 *  with a warning. */
export function assertSecureTransport(registry, { insecureHttp = false } = {}) {
  let url
  try {
    url = new URL(registry)
  } catch {
    throw new Error(`registry '${registry}' is not a valid URL`)
  }
  if (url.protocol === 'https:') return
  if (url.protocol !== 'http:') throw new Error(`registry '${registry}' must use https`)
  if (LOOPBACK_HOSTS.has(url.hostname)) return
  if (!insecureHttp) {
    throw new Error(
      `refusing to send a publish token to ${registry} over plain http; use https, a loopback registry, or --insecure-http for local development`,
    )
  }
  console.error(`navide-plugin: warning: --insecure-http sends the publish token to ${registry} unencrypted`)
}

function configDir() {
  if (process.env[CONFIG_DIR_ENV]) return process.env[CONFIG_DIR_ENV]
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'navide-plugin')
}

export function credentialsPath() {
  return join(configDir(), 'credentials.json')
}

function readCredentials() {
  try {
    const value = JSON.parse(readFileSync(credentialsPath(), 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

/** Replace the whole file owner-only (0600) and atomically. */
function writeCredentials(data) {
  const path = credentialsPath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp`
  const fd = openSync(temporary, 'w', 0o600)
  try {
    writeSync(fd, `${JSON.stringify(data, null, 2)}\n`)
  } finally {
    closeSync(fd)
  }
  chmodSync(temporary, 0o600)
  renameSync(temporary, path)
  return path
}

export function storedCredentials(registry) {
  const entry = readCredentials()[registry]
  return entry && typeof entry === 'object' && typeof entry.token === 'string' ? entry : null
}

export function removeCredentials(registry) {
  const data = readCredentials()
  if (!(registry in data)) return false
  delete data[registry]
  writeCredentials(data)
  return true
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString('base64url')
}

export function openBrowser(url) {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]]
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  } catch {
    // The URL is printed; the user can open it by hand.
  }
}

/** Listen on an ephemeral 127.0.0.1 port for the one `/callback` redirect.
 *  Resolves { port, result } once listening; `result` settles with the
 *  callback's query parameters or rejects on timeout. */
function startCallbackServer(timeoutMs) {
  return new Promise((ready, failed) => {
    let settle
    const result = new Promise((resolve, reject) => {
      settle = { resolve, reject }
    })
    let done = false
    const server = createServer((request, response) => {
      // Only the browser redirect to this loopback port; a DNS-rebound page
      // would carry its own host name.
      const { port } = server.address()
      if (request.headers.host !== `127.0.0.1:${port}` && request.headers.host !== `localhost:${port}`) {
        response.writeHead(400).end()
        return
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback' || done) {
        response.writeHead(404).end()
        return
      }
      done = true
      clearTimeout(timer)
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' })
      response.end('navide-plugin: you can close this tab and return to the terminal.\n', () => server.close())
      settle.resolve(Object.fromEntries(url.searchParams))
    })
    const timer = setTimeout(() => {
      done = true
      server.close()
      settle.reject(new Error('login timed out waiting for the browser'))
    }, timeoutMs)
    server.on('error', failed)
    server.listen(0, '127.0.0.1', () => ready({ port: server.address().port, result }))
  })
}

/** Browser sign-in: loopback redirect checked against `state`, code exchanged
 *  with a PKCE verifier. Returns { token, namespace, expires_at }. */
export async function login(registry, { label, noBrowser, timeoutMs = LOGIN_TIMEOUT_MS }) {
  const verifier = base64Url(randomBytes(48))
  const state = base64Url(randomBytes(24))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  const { port, result } = await startCallbackServer(timeoutMs)
  const query = new URLSearchParams({ port: String(port), state, code_challenge: challenge, label })
  const url = `${registry}/cli/authorize?${query}`
  console.log(`Opening ${url}\nIf the browser does not open, visit that URL.`)
  if (!noBrowser) openBrowser(url)
  const received = await result
  const got = Buffer.from(String(received.state ?? ''))
  const want = Buffer.from(state)
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    throw new Error('login state mismatch; start `navide-plugin login` again')
  }
  if (received.error === 'access_denied') throw new Error('the request was cancelled in the browser')
  if (!received.code) throw new Error('the registry did not return a code')
  const response = await fetch(`${registry}/api/cli/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: received.code, code_verifier: verifier }),
  })
  const body = await response.json().catch(() => ({}))
  if (response.status !== 200 || typeof body.token !== 'string') {
    throw new Error(`token exchange failed (${response.status}): ${body.detail ?? ''}`)
  }
  const entry = { token: body.token, namespace: body.namespace ?? null, expires_at: body.expires_at ?? null }
  const data = readCredentials()
  data[registry] = entry
  return { entry, path: writeCredentials(data) }
}

/** --signature is a signature file path or the base64 signature itself. */
function readSignature(value) {
  if (!value) return null
  try {
    return readRegularFileNoFollow(value).toString('utf8').trim()
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return value.trim()
    throw error
  }
}

/** Upload to `<registry>/api/publish`. Returns { status, body }. */
export async function publish(registry, packagePath, { target, signature, token }) {
  const resolvedToken = resolveToken(registry, token)?.token
  if (!resolvedToken) {
    throw new Error(`publish needs ${TOKEN_ENV} or \`navide-plugin login --registry ${registry}\``)
  }
  const params = new URLSearchParams({ target })
  const signatureValue = readSignature(signature)
  if (signatureValue) params.set('signature', signatureValue)
  const form = new FormData()
  form.append('package', new Blob([readRegularFileNoFollow(packagePath)], { type: 'application/zip' }), basename(packagePath))
  const response = await fetch(`${registry}/api/publish?${params}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${resolvedToken}` },
    body: form,
  })
  return { status: response.status, body: await response.text() }
}

/** The token publish sends: --token, then NAVIDE_PLUGIN_TOKEN, then the stored
 *  login. Returns { token, source, entry? } or null. */
export function resolveToken(registry, token) {
  if (token) return { token, source: '--token' }
  if (process.env[TOKEN_ENV]) return { token: process.env[TOKEN_ENV], source: TOKEN_ENV }
  const entry = storedCredentials(registry)
  return entry ? { token: entry.token, source: credentialsPath(), entry } : null
}

/** GET `<registry><path>` with the publisher token. Returns { status, body }:
 *  the parsed JSON, or null when the response is not JSON. */
export async function getJson(registry, path, token) {
  const response = await fetch(`${registry}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  const text = await response.text()
  try {
    return { status: response.status, body: JSON.parse(text) }
  } catch {
    return { status: response.status, body: null }
  }
}
