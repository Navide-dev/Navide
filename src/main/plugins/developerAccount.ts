// The Host side of a Navide Marketplace developer (plan mcp-navide-0-2-27,
// W3: S4 sign-in, S5 publish, S6 status, yank, the developer application).
//
// Every Registry call that needs a credential goes through here, and the
// credential never leaves: callers get statuses and bodies, never a token or
// the signing key. Sign-in is the CLI's PKCE flow (`navide-plugin login`):
// a loopback callback on 127.0.0.1, `state` checked, the code exchanged with
// the verifier. `scope=account` proves only which Navide Cloud account it is
// (enough to apply and to read one's own versions); `scope=publish` needs an
// approved developer and returns a publisher token for its namespace, after
// which Navide registers its public key so the Registry can check signatures.
import { createHash, createPrivateKey, randomBytes, sign as signDigest, timingSafeEqual } from 'crypto'
import { createServer } from 'http'
import type { DeveloperPublicState, DeveloperTokenScope, DeveloperVault } from './developerVault'
import { publicKeyFingerprint } from './developerVault'

export const DEVELOPER_LOGIN_TIMEOUT_MS = 5 * 60_000
export const DEVELOPER_LOGIN_LABEL = 'Navide app'

export type DeveloperSignInScope = 'account' | 'publish'

export interface DeveloperRequestInit {
  method?: string
  json?: unknown
  body?: RequestInit['body']
  headers?: Record<string, string>
}

export interface DeveloperRegistryResponse<T = unknown> {
  status: number
  body: T
}

export interface DeveloperAccountDeps {
  vault: DeveloperVault
  registryUrl: () => string
  openExternal: (url: string) => Promise<void> | void
  fetch?: typeof fetch
  loginTimeoutMs?: number
}

const NOT_SIGNED_IN = { detail: { code: 'NOT_SIGNED_IN', message: 'sign in as a developer under Settings > Navide Marketplace > Developer' } }
// Registry tokens and PEM keys: never echoed in an error a caller can show or log.
const SECRET_TEXT = /\bnv[a-z]_[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*KEY-----[\s\S]*?(?:-----END [A-Z ]*KEY-----|$)/g

export function redactDeveloperSecrets(text: string): string {
  return text.replace(SECRET_TEXT, '[redacted]')
}

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64url')
}

/** Ed25519 over the package's sha256 hex digest (ASCII): what `navide-plugin sign` produces. */
export function signPackageDigest(digest: string, privateKeyPem: string): string {
  return signDigest(null, Buffer.from(digest, 'ascii'), createPrivateKey(privateKeyPem)).toString('base64')
}

export function packageDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The Registry's error code and message from a response body, if it has one. */
export function registryError(body: unknown): { code: string | null; message: string } {
  const detail = (body as { detail?: unknown } | null)?.detail
  if (detail && typeof detail === 'object') {
    const { code, message } = detail as { code?: unknown; message?: unknown }
    return {
      code: typeof code === 'string' ? code : null,
      message: redactDeveloperSecrets(typeof message === 'string' ? message : JSON.stringify(detail)),
    }
  }
  return { code: null, message: redactDeveloperSecrets(typeof detail === 'string' ? detail : '') }
}

interface CallbackServer {
  port: number
  result: Promise<Record<string, string>>
  close: () => void
}

function startCallbackServer(timeoutMs: number): Promise<CallbackServer> {
  return new Promise((ready, failed) => {
    let settle!: { resolve: (v: Record<string, string>) => void; reject: (e: Error) => void }
    const result = new Promise<Record<string, string>>((resolve, reject) => {
      settle = { resolve, reject }
    })
    let done = false
    const server = createServer((request, response) => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      // Only the browser redirect to this loopback port; a DNS-rebound page carries its own host.
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
      response.end('Navide: you can close this tab and return to Navide.\n', () => server.close())
      settle.resolve(Object.fromEntries(url.searchParams))
    })
    const close = (): void => {
      done = true
      clearTimeout(timer)
      server.close()
    }
    const timer = setTimeout(() => {
      close()
      settle.reject(new Error('sign-in timed out waiting for the browser'))
    }, timeoutMs)
    server.on('error', failed)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      ready({ port: typeof address === 'object' && address ? address.port : 0, result, close })
    })
  })
}

export class DeveloperAccount {
  private readonly fetchImpl: typeof fetch
  private signingIn: Promise<DeveloperPublicState> | null = null

  constructor(private readonly deps: DeveloperAccountDeps) {
    this.fetchImpl = deps.fetch ?? fetch
  }

  private base(): string {
    return this.deps.registryUrl().replace(/\/+$/, '')
  }

  state(): DeveloperPublicState {
    return this.deps.vault.state(this.base())
  }

  signOut(): DeveloperPublicState {
    this.deps.vault.signOut(this.base())
    return this.state()
  }

  /** PKCE sign-in in the user's browser. One at a time. */
  signIn(scope: DeveloperSignInScope): Promise<DeveloperPublicState> {
    if (this.signingIn) return this.signingIn
    this.signingIn = this.runSignIn(scope).finally(() => {
      this.signingIn = null
    })
    return this.signingIn
  }

  private async runSignIn(scope: DeveloperSignInScope): Promise<DeveloperPublicState> {
    const base = this.base()
    const verifier = base64Url(randomBytes(48))
    const state = base64Url(randomBytes(24))
    const challenge = base64Url(createHash('sha256').update(verifier).digest())
    const callback = await startCallbackServer(this.deps.loginTimeoutMs ?? DEVELOPER_LOGIN_TIMEOUT_MS)
    const query = new URLSearchParams({
      port: String(callback.port), state, code_challenge: challenge, label: DEVELOPER_LOGIN_LABEL, scope,
    })
    try {
      await this.deps.openExternal(`${base}/cli/authorize?${query}`)
    } catch (error) {
      callback.close()
      throw error
    }
    const received = await callback.result
    const got = Buffer.from(String(received.state ?? ''))
    const want = Buffer.from(state)
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw new Error('sign-in state mismatch; sign in again')
    if (received.error === 'access_denied') throw new Error('the sign-in was cancelled in the browser')
    if (!received.code) throw new Error('the Navide Marketplace did not return a sign-in code')
    const response = await this.fetchImpl(`${base}/api/cli/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: received.code, code_verifier: verifier }),
    })
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
    if (response.status !== 200 || typeof body.token !== 'string') {
      const { code, message } = registryError(body)
      throw new Error(`sign-in failed (${response.status}${code ? ` ${code}` : ''}): ${message}`)
    }
    const tokenScope: DeveloperTokenScope = body.scope === 'publisher' ? 'publisher' : 'account'
    const namespace = typeof body.namespace === 'string' ? body.namespace : null
    const expiresAt = typeof body.expires_at === 'string' ? body.expires_at : null
    this.deps.vault.saveToken(base, tokenScope, body.token, expiresAt, namespace)
    if (tokenScope === 'publisher') await this.registerKey()
    return this.state()
  }

  /** Register Navide's public key for the signed-in publisher (PUT /api/publisher/me/key). */
  async registerKey(): Promise<DeveloperPublicState> {
    const base = this.base()
    const { publicKeyPem } = this.deps.vault.signingKey(base)
    const res = await this.registryFetch('/api/publisher/me/key', { method: 'PUT', json: { public_key: publicKeyPem } }, 'publisher')
    if (res.status !== 200) {
      const { code, message } = registryError(res.body)
      throw new Error(`the signing key was not registered (${res.status}${code ? ` ${code}` : ''}): ${message}`)
    }
    // The key this Navide sent is the one registered, whatever format the Registry reports its fingerprint in.
    this.deps.vault.markKeyRegistered(base, publicKeyFingerprint(publicKeyPem))
    return this.state()
  }

  /** A Registry call with the kept credential; the token is added here and never returned. */
  async registryFetch<T = unknown>(
    path: string,
    init: DeveloperRequestInit,
    auth: DeveloperTokenScope,
  ): Promise<DeveloperRegistryResponse<T>> {
    const response = await this.authorized(path, init, auth)
    if (!response) return { status: 401, body: NOT_SIGNED_IN as T }
    const text = await response.text()
    let body: unknown = text
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = { detail: redactDeveloperSecrets(text.slice(0, 500)) }
    }
    return { status: response.status, body: body as T }
  }

  /** A binary Registry download with the kept credential, with its `X-Package-Digest`. */
  async registryDownload(path: string, auth: DeveloperTokenScope): Promise<{ status: number; body: Buffer; digest: string | null }> {
    const response = await this.authorized(path, {}, auth)
    if (!response) return { status: 401, body: Buffer.from(JSON.stringify(NOT_SIGNED_IN)), digest: null }
    return {
      status: response.status,
      body: Buffer.from(await response.arrayBuffer()),
      digest: response.headers.get('X-Package-Digest'),
    }
  }

  private async authorized(
    path: string,
    init: DeveloperRequestInit,
    auth: DeveloperTokenScope,
  ): Promise<Response | null> {
    if (!path.startsWith('/')) throw new Error('a Registry path starts with /')
    const base = this.base()
    // An account-scoped call may use the publisher token: both name the same account.
    const token = this.deps.vault.token(base, auth) ?? (auth === 'account' ? this.deps.vault.token(base, 'publisher') : null)
    if (!token) return null
    const headers: Record<string, string> = { ...(init.headers ?? {}), Authorization: `Bearer ${token}` }
    let body = init.body
    if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(init.json)
    }
    return this.fetchImpl(`${base}${path}`, { method: init.method ?? 'GET', headers, body })
  }

  application(): Promise<DeveloperRegistryResponse> {
    return this.registryFetch('/api/developer/me/application', {}, 'account')
  }

  submitApplication(
    fields: Record<string, string | boolean>,
    fieldSources: Record<string, 'user' | 'agent-draft'>,
  ): Promise<DeveloperRegistryResponse> {
    return this.registryFetch(
      '/api/developer/me/application',
      { method: 'POST', json: { fields, field_sources: fieldSources, source: 'navide-app' } },
      'account',
    )
  }

  me(): Promise<DeveloperRegistryResponse> {
    return this.registryFetch('/api/publisher/me', {}, 'publisher')
  }

  versions(): Promise<DeveloperRegistryResponse> {
    return this.registryFetch('/api/publisher/me/versions', {}, 'account')
  }

  /** Sign `bytes` with the kept key and upload them (POST /api/publish). */
  async publish(bytes: Uint8Array, fileName: string, target: string): Promise<DeveloperRegistryResponse & { digest: string }> {
    const base = this.base()
    if (!this.deps.vault.token(base, 'publisher')) return { status: 401, body: NOT_SIGNED_IN, digest: '' }
    if (!this.state().keyRegistered) await this.registerKey()
    const digest = packageDigest(bytes)
    const signature = signPackageDigest(digest, this.deps.vault.signingKey(base).privateKeyPem)
    const form = new FormData()
    form.append('package', new Blob([bytes], { type: 'application/zip' }), fileName)
    const query = new URLSearchParams({ target, signature })
    const res = await this.registryFetch(`/api/publish?${query}`, { method: 'POST', body: form }, 'publisher')
    return { ...res, digest }
  }

  yank(namespace: string, name: string, version: string): Promise<DeveloperRegistryResponse> {
    const path = `/api/extensions/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/yank`
    return this.registryFetch(path, { method: 'POST' }, 'publisher')
  }
}

// One Host-wide developer account, set up from index.ts. The Testplace tools
// (W5) call these rather than the vault, so no caller ever holds a token.
let current: DeveloperAccount | null = null

export function setDeveloperAccount(account: DeveloperAccount | null): void {
  current = account
}

function requireAccount(): DeveloperAccount {
  if (!current) throw new Error('the Navide Marketplace developer account is not available')
  return current
}

export function getDeveloperState(): DeveloperPublicState {
  return requireAccount().state()
}

export function signInDeveloper(scope: DeveloperSignInScope): Promise<DeveloperPublicState> {
  return requireAccount().signIn(scope)
}

export function developerRegistryFetch<T = unknown>(
  path: string,
  init: DeveloperRequestInit,
  auth: DeveloperTokenScope,
): Promise<DeveloperRegistryResponse<T>> {
  return requireAccount().registryFetch<T>(path, init, auth)
}

export function developerRegistryDownload(
  path: string,
  auth: DeveloperTokenScope,
): Promise<{ status: number; body: Buffer; digest: string | null }> {
  return requireAccount().registryDownload(path, auth)
}
