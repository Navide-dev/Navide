import { createPublicKey, verify } from 'crypto'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeveloperAccount, packageDigest, redactDeveloperSecrets, registryError } from './developerAccount'
import { DeveloperVault, DeveloperVaultUnavailableError, type DeveloperVaultCrypto } from './developerVault'
import { applicationView, createDeveloperQueryHandler, isLoopbackRegistryUrl, membersView } from './developerIpc'

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

describe('reclaimed namespaces in the application (W2)', () => {
  const namespaces = [
    { namespace: 'acme', frozen_at: '2026-10-20T01:00:00Z', frozen_reason: 'not claimed again within 30 days', extra: 'dropped' },
    { namespace: 'old-tools', frozen_at: null, frozen_reason: null },
  ]
  const body = { status: 'rejected', fields: {}, field_sources: {}, reason: 'incomplete', namespaces }
  const expected = [
    { namespace: 'acme', frozen_at: '2026-10-20T01:00:00Z', frozen_reason: 'not claimed again within 30 days' },
    { namespace: 'old-tools', frozen_at: null, frozen_reason: null },
  ]

  it('applicationView passes namespace, frozen_at and frozen_reason through as they are', () => {
    expect(applicationView(body)?.namespaces).toEqual(expected)
  })

  it('the agent gets them in marketplace_developer_status', async () => {
    vault.saveToken(REGISTRY, 'account', ACCOUNT_TOKEN, null, null)
    const { account: dev } = account(() => ({ status: 200, body }))
    const answer = await createDeveloperQueryHandler(dev)({ kind: 'developer-status' })
    expect(answer).toMatchObject({ ok: true, result: { application: { namespaces: expected } } })
  })
})

describe('Registry calls that carry the kept credential', () => {
  it('stops reading a package download past the size cap instead of buffering it whole', async () => {
    vault.saveToken(REGISTRY, 'account', ACCOUNT_TOKEN, '2099-01-01T00:00:00Z', null)
    const chunk = new Uint8Array(1024 * 1024)
    let pulled = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        if (pulled > 300) controller.close()
        else controller.enqueue(chunk)
      },
    })
    const impl = vi.fn(async () => new Response(stream, { status: 200 }))
    const acct = new DeveloperAccount({ vault, registryUrl: () => REGISTRY, openExternal: vi.fn(), fetch: impl as unknown as typeof fetch })
    await expect(acct.registryDownload('/api/testplace/a/b/1.0.0/download', 'account')).rejects.toThrow(/larger than/)
    expect(pulled).toBeLessThan(300)
  })
})

describe('L1d: a key the Registry already holds is never replaced by itself', () => {
  it('records the conflict instead of failing, keeps the CLI key publishing, and replaces only on request', async () => {
    vault.saveToken(REGISTRY, 'publisher', PUBLISHER_TOKEN, null, 'nerdtechnic')
    let registered: string | null = 'sha256:cli-key'
    const { account: dev, calls } = account((call) => {
      if (call.url.endsWith('/api/publisher/me/key')) {
        const body = JSON.parse(String(call.body)) as { public_key: string; replace?: boolean }
        if (registered && !body.replace) {
          return { status: 409, body: { detail: { code: 'KEY_EXISTS', message: 'another key', public_key_fingerprint: registered } } }
        }
        registered = null
        return { status: 200, body: { public_key_fingerprint: 'sha256:navide-key' } }
      }
      if (new URL(call.url).pathname.endsWith('/api/publish')) return { status: 201, body: { ok: true } }
      return { status: 404, body: {} }
    })
    // Sign-in's automatic registration meets the dashboard key: no throw, the conflict is state.
    const state = await dev.registerKey()
    expect(state).toMatchObject({ keyRegistered: false, keyConflictFingerprint: 'sha256:cli-key' })
    expect(JSON.parse(String(calls.at(-1)!.body))).not.toHaveProperty('replace')
    // Publishing from here says what is going on instead of letting the Registry answer 403.
    const refused = await dev.publish(new TextEncoder().encode('PK'), 'x.vsix', 'universal')
    expect(refused.status).toBe(409)
    expect(JSON.stringify(refused.body)).toContain('sha256:cli-key')
    expect(calls.some((call) => new URL(call.url).pathname.endsWith('/api/publish'))).toBe(false)
    // The user's explicit replacement is the only thing that changes the key.
    const replaced = await dev.registerKey({ replace: true })
    expect(JSON.parse(String(calls.at(-1)!.body)).replace).toBe(true)
    expect(replaced).toMatchObject({ keyRegistered: true, keyConflictFingerprint: null })
    expect((await dev.publish(new TextEncoder().encode('PK'), 'x.vsix', 'universal')).status).toBe(201)
  })
})

describe('namespace members (0.2.40)', () => {
  const registryMembers = {
    namespace: 'nerdtechnic',
    your_role: 'owner',
    members: [
      { member_id: 'mem-owner', role: 'owner', added_by: null, added_at: null },
      { member_id: 'mem-pub', role: 'publisher', added_by: 'member:mem-owner', added_at: '2026-11-10T05:00:00+00:00' },
    ],
  }
  const view = {
    your_role: 'owner',
    items: [
      { member_id: 'mem-owner', role: 'owner', added_at: null },
      { member_id: 'mem-pub', role: 'publisher', added_at: '2026-11-10T05:00:00+00:00' },
    ],
  }

  it('membersView keeps ids, roles and dates only', () => {
    expect(membersView(registryMembers)).toEqual(view)
    expect(membersView({ your_role: 'admin', members: [{ member_id: 'x', role: 'maintainer' }] }))
      .toEqual({ your_role: null, items: [{ member_id: 'x', role: 'publisher', added_at: null }] })
  })

  it('adds and removes a member with the publisher token', async () => {
    vault.saveToken(REGISTRY, 'publisher', PUBLISHER_TOKEN, null, 'nerdtechnic')
    const { account: dev, calls } = account(() => ({ status: 200, body: registryMembers }))
    await dev.addMember('mem-new')
    await dev.removeMember('mem/../x')
    expect(calls.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
      ['POST', '/registry/api/publisher/me/members'],
      ['DELETE', '/registry/api/publisher/me/members/mem%2F..%2Fx'],
    ])
    expect(JSON.parse(String(calls[0].body))).toEqual({ member_id: 'mem-new', role: 'publisher' })
    expect(calls[0].headers.Authorization).toBe(`Bearer ${PUBLISHER_TOKEN}`)
  })

  it('the agent reads members, read-only, in marketplace_developer_status', async () => {
    vault.saveToken(REGISTRY, 'publisher', PUBLISHER_TOKEN, null, 'nerdtechnic')
    const { account: dev, calls } = account((call) =>
      call.url.endsWith('/api/publisher/me/members')
        ? { status: 200, body: registryMembers }
        : { status: 200, body: { status: 'approved', fields: {}, field_sources: {} } })
    const answer = await createDeveloperQueryHandler(dev)({ kind: 'developer-status' })
    expect(answer).toMatchObject({ ok: true, result: { members: view } })
    expect(calls.every((call) => call.method === 'GET')).toBe(true)
    expect(JSON.stringify(answer)).not.toContain(PUBLISHER_TOKEN)
  })

  it('has no members without a publisher sign-in', async () => {
    vault.saveToken(REGISTRY, 'account', ACCOUNT_TOKEN, null, null)
    const { account: dev, calls } = account(() => ({ status: 200, body: { status: 'none' } }))
    const answer = await createDeveloperQueryHandler(dev)({ kind: 'developer-status' })
    expect(answer).toMatchObject({ ok: true, result: { members: null } })
    expect(calls.some((call) => call.url.endsWith('/members'))).toBe(false)
  })
})

describe('registryError (0.2.40 c3)', () => {
  const doc = 'https://github.com/Navide-dev/Navide/blob/main/docs/en-US/marketplace-publishing.md#testplace'

  it('reads the code and message as before and keeps a Navide doc link', () => {
    expect(registryError({ detail: { code: 'OWNER_ONLY', message: 'owner only' }, doc }))
      .toEqual({ code: 'OWNER_ONLY', message: 'owner only', doc })
    expect(registryError({ detail: 'extension not found' })).toEqual({ code: null, message: 'extension not found', doc: null })
  })

  it('takes a top-level CAPABILITY_DENIED and links its section when the body has no doc', () => {
    expect(registryError({ detail: 'static scan found network hosts the manifest does not declare: x.net', code: 'CAPABILITY_DENIED' }))
      .toEqual({
        code: 'CAPABILITY_DENIED',
        message: 'static scan found network hosts the manifest does not declare: x.net',
        doc: 'https://github.com/Navide-dev/Navide/blob/main/docs/en-US/plugin-development-v2.md#capability_denied',
      })
  })

  it('drops a doc that is not Navide documentation', () => {
    for (const bad of ['http://github.com/Navide-dev/Navide/x', 'https://evil.example/doc', 'https://github.com/other/repo', 'javascript:alert(1)', 42]) {
      expect(registryError({ detail: 'x', doc: bad }).doc).toBeNull()
    }
    expect(registryError({ detail: 'x', doc: 'https://developers.navide.dev/developer' }).doc).toBe('https://developers.navide.dev/developer')
    expect(registryError({ detail: 'x', doc: 'https://navide.dev.evil.example/' }).doc).toBeNull()
  })
})
