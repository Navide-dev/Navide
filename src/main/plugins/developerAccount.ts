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
//
// 0.2.43 #2b: when this Navide is signed in to Navide Cloud, the same account
// is reused instead of a second browser sign-in. The backend asks the Cloud
// server for a 60-second, single-use assertion bound to a PKCE challenge made
// here, and only that assertion crosses to this process (the Cloud token stays
// in the backend); the Registry exchanges assertion + verifier for the same
// tokens (`/api/cli/cloud-exchange`). Publishing rights still take one step:
// a native confirm dialog from this process, which no renderer or agent can
// click. Anything missing (no Cloud sign-in, a self-hosted server, a Registry
// or server without the endpoint) falls back to the browser flow unchanged.
import { createHash, createPrivateKey, randomBytes, sign as signDigest, timingSafeEqual } from 'crypto'
import { createServer } from 'http'
import type { DeveloperPublicState, DeveloperTokenScope, DeveloperVault } from './developerVault'
import { publicKeyFingerprint } from './developerVault'
import { PACKAGE_DOWNLOAD_MAX_BYTES, readBodyCapped } from './readBodyCapped'
import { CAPABILITY_DENIED_DOC_URL, trustedDocUrl } from '../../shared/marketplaceDeveloper'

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

export type CloudAssertionResult =
  | { ok: true; assertion: string; memberId: string }
  | { ok: false; code: string; message: string }

/** The backend's Navide Cloud link as the developer sign-in sees it: who is
 *  signed in, and an assertion for the Registry. Never the Cloud token. */
export interface DeveloperCloudBridge {
  identity(): Promise<{ memberId: string; name: string } | null>
  assertion(request: { scope: DeveloperSignInScope; namespace: string | null; challenge: string }): Promise<CloudAssertionResult>
}

/** What the publish-rights confirmation shows; resolves the namespace the user granted, or null. */
export interface PublishConfirmRequest {
  accountName: string
  memberId: string
  namespaces: string[]
}

export interface DeveloperAccountDeps {
  vault: DeveloperVault
  registryUrl: () => string
  openExternal: (url: string) => Promise<void> | void
  fetch?: typeof fetch
  loginTimeoutMs?: number
  /** Absent: browser sign-in only. */
  cloud?: DeveloperCloudBridge
  /** A main-process native dialog; absent: publishing rights always go through the browser. */
  confirmPublish?: (request: PublishConfirmRequest) => Promise<string | null>
}

/** The Cloud path cannot be used here; the caller falls back to the browser. */
class CloudUnavailable extends Error {}

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

/** The Registry's error code, message and documentation page (c3: the body's
 *  `doc`, kept only when it is Navide's own) from a response body, if it has them. */
export function registryError(body: unknown): { code: string | null; message: string; doc: string | null } {
  const record = body as { detail?: unknown; code?: unknown; doc?: unknown } | null
  const detail = record?.detail
  let code: string | null = typeof record?.code === 'string' ? record.code : null
  let message: string
  if (detail && typeof detail === 'object') {
    const inner = detail as { code?: unknown; message?: unknown }
    if (typeof inner.code === 'string') code = inner.code
    message = redactDeveloperSecrets(typeof inner.message === 'string' ? inner.message : JSON.stringify(detail))
  } else {
    message = redactDeveloperSecrets(typeof detail === 'string' ? detail : '')
  }
  const doc = trustedDocUrl(record?.doc) ?? (code === 'CAPABILITY_DENIED' ? CAPABILITY_DENIED_DOC_URL : null)
  return { code, message, doc }
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

  /** Sign in: through the Navide Cloud account when it can be used, else
   *  PKCE in the user's browser. One at a time. */
  signIn(scope: DeveloperSignInScope): Promise<DeveloperPublicState> {
    if (this.signingIn) return this.signingIn
    this.signingIn = this.runCloudSignIn(scope)
      .catch((error: unknown) => {
        if (error instanceof CloudUnavailable) return this.runSignIn(scope)
        throw error
      })
      .finally(() => {
        this.signingIn = null
      })
    return this.signingIn
  }

  /** The account-scope sign-in through Navide Cloud, without a browser or a
   *  click (an account token proves only who it is). Never opens a browser:
   *  when the Cloud path is unavailable it returns the state unchanged. Also
   *  forgets tokens left by a different Cloud member. */
  syncCloudAccount(): Promise<DeveloperPublicState> {
    if (this.signingIn) return this.signingIn
    this.signingIn = this.runCloudAccountSync().finally(() => {
      this.signingIn = null
    })
    return this.signingIn
  }

  private async runCloudAccountSync(): Promise<DeveloperPublicState> {
    try {
      const identity = await this.cloudIdentity()
      const state = this.state()
      if (state.signedIn.account || state.signedIn.publisher) return state
      await this.cloudExchange('account', null, identity.memberId)
    } catch (error) {
      if (!(error instanceof CloudUnavailable)) throw error
    }
    return this.state()
  }

  private async cloudIdentity(): Promise<{ memberId: string; name: string }> {
    const identity = this.deps.cloud ? await this.deps.cloud.identity().catch(() => null) : null
    if (!identity) throw new CloudUnavailable('not signed in to Navide Cloud')
    const base = this.base()
    const kept = this.deps.vault.cloudMember(base)
    // Tokens exchanged for another Cloud account are not this account's.
    if (kept && kept !== identity.memberId) this.deps.vault.signOut(base)
    return identity
  }

  private async runCloudSignIn(scope: DeveloperSignInScope): Promise<DeveloperPublicState> {
    const identity = await this.cloudIdentity()
    if (scope === 'account') {
      await this.cloudExchange('account', null, identity.memberId)
      return this.state()
    }
    if (!this.deps.confirmPublish) throw new CloudUnavailable('no publish confirmation available')
    const state = this.state()
    if (!state.signedIn.account && !state.signedIn.publisher) await this.cloudExchange('account', null, identity.memberId)
    const list = await this.registryFetch<{ namespaces?: unknown }>('/api/developer/me/namespaces', {}, 'account')
    // A Registry from before the Cloud sign-in: the browser page lists the namespaces.
    if (list.status === 404) throw new CloudUnavailable('the Registry cannot list namespaces')
    if (list.status !== 200) {
      const { code, message } = registryError(list.body)
      throw new Error(`the namespaces could not be read (${list.status}${code ? ` ${code}` : ''}): ${message}`)
    }
    const raw = list.body?.namespaces
    const namespaces = (Array.isArray(raw) ? raw : []).filter((item): item is string => typeof item === 'string')
    if (namespaces.length === 0) {
      throw new Error('this Navide Cloud account has no namespace it may publish to yet: apply for developer qualification first, then create or join a namespace')
    }
    const namespace = await this.deps.confirmPublish({ accountName: identity.name, memberId: identity.memberId, namespaces })
    if (!namespace) throw new Error('publishing rights were not granted')
    if (!namespaces.includes(namespace)) throw new Error('that namespace was not offered')
    await this.cloudExchange('publish', namespace, identity.memberId)
    return this.state()
  }

  /** Assertion from the backend, then `/api/cli/cloud-exchange` with the verifier. */
  private async cloudExchange(scope: DeveloperSignInScope, namespace: string | null, memberId: string): Promise<void> {
    const cloud = this.deps.cloud
    if (!cloud) throw new CloudUnavailable('no Navide Cloud link')
    const base = this.base()
    const verifier = base64Url(randomBytes(48))
    const challenge = base64Url(createHash('sha256').update(verifier).digest())
    const issued = await cloud.assertion({ scope, namespace, challenge }).catch(
      (error: unknown): CloudAssertionResult => ({ ok: false, code: 'HOST_ERROR', message: String(error) }),
    )
    if (!issued.ok) throw new CloudUnavailable(`no Cloud assertion (${issued.code})`)
    if (issued.memberId !== memberId) throw new CloudUnavailable('the Cloud account changed during sign-in')
    const response = await this.fetchImpl(`${base}/api/cli/cloud-exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assertion: issued.assertion, code_verifier: verifier, scope, namespace, label: DEVELOPER_LOGIN_LABEL }),
    })
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
    const { code, message } = registryError(body)
    // No endpoint (an older Registry) or an assertion it cannot trust (a
    // self-hosted Cloud server, a rotated key): the browser still works.
    if (response.status === 404 && scope === 'account') throw new CloudUnavailable('the Registry has no Cloud sign-in')
    if (response.status === 401 && code?.startsWith('ASSERTION_')) throw new CloudUnavailable(`the Registry refused the assertion (${code})`)
    if (response.status !== 200 || typeof body.token !== 'string') {
      throw new Error(`sign-in failed (${response.status}${code ? ` ${code}` : ''}): ${message}`)
    }
    await this.keepSignIn(base, body)
    this.deps.vault.setCloudMember(base, memberId)
  }

  /** Store a `/api/cli/token`-shaped answer; a publisher token also registers the key. */
  private async keepSignIn(base: string, body: Record<string, unknown>): Promise<void> {
    if (typeof body.token !== 'string') throw new Error('the Navide Marketplace returned no token')
    const tokenScope: DeveloperTokenScope = body.scope === 'publisher' ? 'publisher' : 'account'
    const namespace = typeof body.namespace === 'string' ? body.namespace : null
    const expiresAt = typeof body.expires_at === 'string' ? body.expires_at : null
    this.deps.vault.saveToken(base, tokenScope, body.token, expiresAt, namespace)
    if (tokenScope === 'publisher') await this.registerKey()
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
    // A browser sign-in names no Cloud member this Navide can check.
    this.deps.vault.setCloudMember(base, null)
    await this.keepSignIn(base, body)
    return this.state()
  }

  /** Register Navide's public key for the signed-in publisher (PUT /api/publisher/me/key).
   *  L1d: a different key the Registry already holds (the developer's CLI
   *  key, registered on the dashboard) is never replaced by itself — the
   *  Registry answers 409 KEY_EXISTS, which is recorded as the state's
   *  `keyConflictFingerprint` and is not an error: the other key keeps
   *  publishing. Only `replace: true`, the user's explicit choice in
   *  Settings, replaces it. */
  async registerKey(options: { replace?: boolean } = {}): Promise<DeveloperPublicState> {
    const base = this.base()
    const { publicKeyPem } = this.deps.vault.signingKey(base)
    const res = await this.registryFetch(
      '/api/publisher/me/key',
      { method: 'PUT', json: { public_key: publicKeyPem, ...(options.replace ? { replace: true } : {}) } },
      'publisher',
    )
    if (res.status === 409 && registryError(res.body).code === 'KEY_EXISTS') {
      const detail = (res.body as { detail?: { public_key_fingerprint?: unknown } } | null)?.detail
      const fingerprint = typeof detail?.public_key_fingerprint === 'string' ? detail.public_key_fingerprint : 'unknown'
      this.deps.vault.markKeyConflict(base, fingerprint)
      return this.state()
    }
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
    const bytes = await readBodyCapped(response, PACKAGE_DOWNLOAD_MAX_BYTES)
    if (!bytes) throw new Error(`the Registry download is larger than ${PACKAGE_DOWNLOAD_MAX_BYTES} bytes`)
    return {
      status: response.status,
      body: Buffer.from(bytes),
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
    const conflict = this.state().keyConflictFingerprint
    if (!this.state().keyRegistered && conflict) {
      // L1d: the Registry holds another key; a package signed here would be
      // refused as "invalid package signature", so say what is going on.
      return {
        status: 409,
        body: {
          detail: {
            code: 'KEY_EXISTS',
            message: `the Registry has another signing key registered for this publisher (fingerprint ${conflict}); publish with that key, or replace it with this Navide's key in Settings → Navide Plugins → Developer`,
          },
        },
        digest: '',
      }
    }
    const digest = packageDigest(bytes)
    const signature = signPackageDigest(digest, this.deps.vault.signingKey(base).privateKeyPem)
    const form = new FormData()
    // A copy backed by a plain ArrayBuffer: a Blob part may not be a SharedArrayBuffer view.
    form.append('package', new Blob([new Uint8Array(bytes)], { type: 'application/zip' }), fileName)
    const query = new URLSearchParams({ target, signature })
    const res = await this.registryFetch(`/api/publish?${query}`, { method: 'POST', body: form }, 'publisher')
    return { ...res, digest }
  }

  /** The signed-in namespace's owner and publisher members (0.2.40), with the caller's role. */
  members(): Promise<DeveloperRegistryResponse> {
    return this.registryFetch('/api/publisher/me/members', {}, 'publisher')
  }

  /** Owner only (the Registry refuses anyone else): add a publisher member. */
  addMember(memberId: string): Promise<DeveloperRegistryResponse> {
    return this.registryFetch('/api/publisher/me/members', { method: 'POST', json: { member_id: memberId, role: 'publisher' } }, 'publisher')
  }

  /** Owner only: remove a publisher member; the Registry revokes its tokens for the namespace. */
  removeMember(memberId: string): Promise<DeveloperRegistryResponse> {
    return this.registryFetch(`/api/publisher/me/members/${encodeURIComponent(memberId)}`, { method: 'DELETE' }, 'publisher')
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
