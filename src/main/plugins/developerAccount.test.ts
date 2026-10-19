import { createPublicKey, verify } from 'crypto'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeveloperAccount, packageDigest, redactDeveloperSecrets } from './developerAccount'
import { DeveloperVault, DeveloperVaultUnavailableError, type DeveloperVaultCrypto } from './developerVault'
import { createDeveloperQueryHandler, isLoopbackRegistryUrl } from './developerIpc'

// Built by concatenation so no scanner mistakes a fixture for a credential.
const ACCOUNT_TOKEN = 'nva' + '_' + 'acc0unt' + 'Q'.repeat(24)
const PUBLISHER_TOKEN = 'nvp' + '_' + 'publ1sher' + 'R'.repeat(24)
const REGISTRY = 'https://registry.example.test/registry'

const fakeCrypto = (available = true): DeveloperVaultCrypto => ({
  available,
  encrypt: (plain) => Buffer.from(Buffer.from(plain).map((b) => b ^ 0x5a)).toString('base64'),
  decrypt: (enc) => Buffer.from(Buffer.from(enc, 'base64').map((b) => b ^ 0x5a)).toString(),
})

interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }

function fakeFetch(answer: (call: Call) => { status: number; body: unknown; headers?: Record<string, string> }) {
  const calls: Call[] = []
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: init?.body,
    }
    calls.push(call)
    const { status, body, headers } = answer(call)
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    return new Response(text, { status, headers })
  })
  return { impl: impl as unknown as typeof fetch, calls }
}

let dir: string
let vault: DeveloperVault
let consoleText: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'navide-dev-vault-'))
  vault = new DeveloperVault(join(dir, 'marketplace-developer.json'), fakeCrypto())
  consoleText = []
  for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      consoleText.push(args.map(String).join(' '))
    })
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

function account(answer: Parameters<typeof fakeFetch>[0], openExternal = vi.fn()) {
  const fetcher = fakeFetch(answer)
  return { account: new DeveloperAccount({ vault, registryUrl: () => REGISTRY, openExternal, fetch: fetcher.impl }), ...fetcher, openExternal }
}

describe('DeveloperVault', () => {
  it('keeps tokens and the private key only as ciphertext', () => {
    vault.saveToken(REGISTRY, 'publisher', PUBLISHER_TOKEN, null, 'nerdtechnic')
    const { privateKeyPem } = vault.signingKey(REGISTRY)
    const onDisk = readFileSync(join(dir, 'marketplace-developer.json'), 'utf8')
    expect(onDisk).not.toContain(PUBLISHER_TOKEN)
    expect(onDisk).not.toContain('PRIVATE KEY')
    expect(onDisk).not.toContain(privateKeyPem.split('\n')[1])
    expect(vault.token(REGISTRY, 'publisher')).toBe(PUBLISHER_TOKEN)
  })

  it('shows a state with no token and no key', () => {
    vault.saveToken(REGISTRY, 'account', ACCOUNT_TOKEN, '2099-01-01T00:00:00Z', null)
    vault.signingKey(REGISTRY)
    const state = JSON.stringify(vault.state(REGISTRY))
    expect(state).not.toContain(ACCOUNT_TOKEN)
    expect(state).not.toContain('PRIVATE')
    expect(vault.state(REGISTRY).signedIn).toEqual({ account: true, publisher: false })
  })

  it('treats an expired token as signed out', () => {
    vault.saveToken(REGISTRY, 'account', ACCOUNT_TOKEN, '2000-01-01T00:00:00Z', null)
    expect(vault.token(REGISTRY, 'account')).toBeNull()
    expect(vault.state(REGISTRY).signedIn.account).toBe(false)
  })

  it('refuses to keep a secret without real encryption', () => {
    const plain = new DeveloperVault(join(dir, 'other.json'), fakeCrypto(false))
    expect(() => plain.saveToken(REGISTRY, 'account', ACCOUNT_TOKEN, null, null)).toThrow(DeveloperVaultUnavailableError)
    expect(() => plain.signingKey(REGISTRY)).toThrow(DeveloperVaultUnavailableError)
  })

  it('signs out without dropping the signing key', () => {
    vault.saveToken(REGISTRY, 'publisher', PUBLISHER_TOKEN, null, 'ns')
    const before = vault.signingKey(REGISTRY).publicKeyPem
    vault.signOut(REGISTRY)
    expect(vault.token(REGISTRY, 'publisher')).toBeNull()
    expect(vault.signingKey(REGISTRY).publicKeyPem).toBe(before)
  })
})

describe('DeveloperAccount', () => {
  it('signs in with PKCE over a loopback callback, and registers the key for a publisher', async () => {
    const opened: string[] = []
    const openExternal = vi.fn(async (url: string) => {
      opened.push(url)
      const params = new URL(url).searchParams
      // The browser's redirect after the user authorised.
      await fetch(`http://127.0.0.1:${params.get('port')}/callback?code=c0de&state=${params.get('state')}`)
    })
    const { account: dev, calls } = account((call) => {
      if (call.url.endsWith('/api/cli/token')) {
        return { status: 200, body: { token: PUBLISHER_TOKEN, scope: 'publisher', namespace: 'nerdtechnic', expires_at: null } }
      }
      if (call.url.endsWith('/api/publisher/me/key')) return { status: 200, body: { public_key_fingerprint: 'SHA256:x' } }
      return { status: 404, body: {} }
    }, openExternal)
    const state = await dev.signIn('publish')
    const authorize = new URL(opened[0])
    expect(authorize.pathname).toBe('/registry/cli/authorize')
    expect(authorize.searchParams.get('scope')).toBe('publish')
    expect(authorize.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const exchange = JSON.parse(String(calls[0].body))
    expect(exchange.code).toBe('c0de')
    expect(exchange.code_verifier).toMatch(/^[A-Za-z0-9_-]{64}$/)
    expect(calls[1].method).toBe('PUT')
    expect(JSON.parse(String(calls[1].body)).public_key).toContain('BEGIN PUBLIC KEY')
    expect(state).toMatchObject({ namespace: 'nerdtechnic', keyRegistered: true, signedIn: { publisher: true } })
    expect(JSON.stringify(state)).not.toContain(PUBLISHER_TOKEN)
  })

  it('adds the token itself and answers NOT_SIGNED_IN without one', async () => {
    const { account: dev, calls } = account(() => ({ status: 200, body: { status: 'none' } }))
    expect(await dev.application()).toEqual({ status: 401, body: { detail: expect.objectContaining({ code: 'NOT_SIGNED_IN' }) } })
    expect(calls).toHaveLength(0)
    vault.saveToken(REGISTRY, 'account', ACCOUNT_TOKEN, null, null)
    const res = await dev.application()
    expect(res).toEqual({ status: 200, body: { status: 'none' } })
    expect(calls[0].headers.Authorization).toBe(`Bearer ${ACCOUNT_TOKEN}`)
  })

  it('signs the package digest with the kept key, the way navide-plugin sign does', async () => {
    vault.saveToken(REGISTRY, 'publisher', PUBLISHER_TOKEN, null, 'nerdtechnic')
    const { account: dev, calls } = account((call) =>
      call.url.includes('/api/publisher/me/key') ? { status: 200, body: {} } : { status: 201, body: { status: 'pending' } })
    const bytes = new TextEncoder().encode('PK fake package bytes')
    const res = await dev.publish(bytes, 'x-1.0.0-universal.vsix', 'universal')
    expect(res.status).toBe(201)
    const upload = new URL(calls.at(-1)!.url)
    expect(upload.pathname).toBe('/registry/api/publish')
    expect(upload.searchParams.get('target')).toBe('universal')
    const signature = Buffer.from(upload.searchParams.get('signature')!, 'base64')
    const publicKey = createPublicKey(vault.signingKey(REGISTRY).publicKeyPem)
    expect(verify(null, Buffer.from(packageDigest(bytes), 'ascii'), publicKey, signature)).toBe(true)
  })

  it('never lets a token or the private key reach an answer, an error or the console', async () => {
    vault.saveToken(REGISTRY, 'account', ACCOUNT_TOKEN, null, null)
    vault.saveToken(REGISTRY, 'publisher', PUBLISHER_TOKEN, null, 'ns')
    const { privateKeyPem } = vault.signingKey(REGISTRY)
    // A hostile or buggy Registry echoes the credential back in every error.
    const { account: dev } = account(() => ({
      status: 400,
      body: { detail: { code: 'X', message: `bad ${PUBLISHER_TOKEN} ${ACCOUNT_TOKEN} ${privateKeyPem}` } },
    }))
    const seen: unknown[] = [dev.state()]
    seen.push(await createDeveloperQueryHandler(dev)({ kind: 'developer-status' }))
    seen.push(await createDeveloperQueryHandler(dev)({ kind: 'publish-status', id: '' }))
    try {
      await dev.registerKey()
    } catch (error) {
      seen.push((error as Error).message)
    }
    const text = JSON.stringify(seen) + consoleText.join('\n')
    for (const secret of [ACCOUNT_TOKEN, PUBLISHER_TOKEN, privateKeyPem.split('\n')[1], 'BEGIN PRIVATE KEY']) {
      expect(text).not.toContain(secret)
    }
    expect(redactDeveloperSecrets(`x ${privateKeyPem.trim()} y`)).toBe('x [redacted] y')
  })
})

describe('O3: a Registry on this computer', () => {
  it.each([
    ['http://127.0.0.1:8787/registry', true],
    ['http://localhost:8787', true],
    ['http://[::1]:8787', true],
    ['http://127.1.2.3', true],
    ['https://server.navide.dev/registry', false],
    ['http://127.0.0.1.evil.com/registry', false],
    ['http://localhost.evil.com', false],
    ['http://127.0.0.1@evil.com', false],
    ['http://evil.com/?127.0.0.1', false],
    ['file:///tmp/registry', false],
    ['not a url', false],
    ['', false],
  ])('%s is loopback: %s', (url, expected) => {
    expect(isLoopbackRegistryUrl(url)).toBe(expected)
  })

  const staged = {
    stageId: 's', path: '/tmp/x.vsix', fileName: 'x.vsix', id: 'ns.x', version: '1.0.0', publisher: 'ns',
    digest: 'd', size: 1, defaultTarget: 'universal', hasBackend: false, disclosure: null,
  }

  it('publishes straight away to a loopback Registry', async () => {
    const publishFromPath = vi.fn(async () => ({ staged, result: { ok: true as const, status: 201, body: {} } }))
    const { account: dev } = account(() => ({ status: 200, body: {} }))
    const answer = await createDeveloperQueryHandler(dev, publishFromPath, () => 'http://127.0.0.1:8787')(
      { kind: 'publish-direct', path: '/tmp/x.vsix', target: '' })
    expect(publishFromPath).toHaveBeenCalledWith('/tmp/x.vsix', '')
    expect(answer).toEqual({ ok: true, result: expect.objectContaining({ loopback: true, published: true, id: 'ns.x' }) })
  })

  it.each([
    ['the Navide Marketplace', 'https://server.navide.dev/registry'],
    ['a look-alike host', 'http://127.0.0.1.evil.com/registry'],
  ])('leaves %s to the user', async (_label, url) => {
    const publishFromPath = vi.fn()
    const { account: dev } = account(() => ({ status: 200, body: {} }))
    const answer = await createDeveloperQueryHandler(dev, publishFromPath, () => url)(
      { kind: 'publish-direct', path: '/tmp/x.vsix', target: '' })
    expect(answer).toEqual({ ok: true, result: { kind: 'publish-direct', loopback: false } })
    expect(publishFromPath).not.toHaveBeenCalled()
  })
})
