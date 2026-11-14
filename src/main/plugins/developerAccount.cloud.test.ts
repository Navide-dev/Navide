// 0.2.43 #2b: the Marketplace developer sign-in reuses the Navide Cloud account.
import { createHash } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeveloperAccount, type CloudAssertionResult, type DeveloperCloudBridge, type PublishConfirmRequest } from './developerAccount'
import { DeveloperVault, type DeveloperVaultCrypto } from './developerVault'
import { publishConfirmDialog } from './developerPublishConfirm'

// Built by concatenation so no scanner mistakes a fixture for a credential.
const ACCOUNT_TOKEN = 'nva' + '_' + 'cl0ud' + 'Q'.repeat(24)
const PUBLISHER_TOKEN = 'nvp' + '_' + 'cl0ud' + 'R'.repeat(24)
const ASSERTION = 'nvsa1' + '.k1.' + 'p'.repeat(20) + '.' + 's'.repeat(20)
const REGISTRY = 'https://registry.example.test/registry'

const fakeCrypto: DeveloperVaultCrypto = {
  available: true,
  encrypt: (plain) => Buffer.from(Buffer.from(plain).map((b) => b ^ 0x5a)).toString('base64'),
  decrypt: (enc) => Buffer.from(Buffer.from(enc, 'base64').map((b) => b ^ 0x5a)).toString(),
}

interface Call { url: string; method: string; body: unknown; auth: string | undefined }

let dir: string
let vault: DeveloperVault

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'navide-dev-cloud-'))
  vault = new DeveloperVault(join(dir, 'marketplace-developer.json'), fakeCrypto)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

interface Setup {
  identity?: { memberId: string; name: string } | null
  assertion?: (request: { scope: string; namespace: string | null; challenge: string }) => CloudAssertionResult
  registry: (call: Call) => { status: number; body: unknown }
  confirm?: (request: PublishConfirmRequest) => Promise<string | null>
}

function setup(options: Setup) {
  const calls: Call[] = []
  const assertions: Array<{ scope: string; namespace: string | null; challenge: string }> = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      auth: headers.Authorization,
    }
    calls.push(call)
    const { status, body } = options.registry(call)
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  const cloud: DeveloperCloudBridge = {
    identity: async () => (options.identity === undefined ? { memberId: 'm_1', name: 'Neo' } : options.identity),
    assertion: async (request) => {
      assertions.push(request)
      return options.assertion ? options.assertion(request) : { ok: true, assertion: ASSERTION, memberId: 'm_1' }
    },
  }
  const openExternal = vi.fn()
  const confirmPublish = vi.fn(options.confirm ?? (async (request: PublishConfirmRequest) => request.namespaces[0]))
  const account = new DeveloperAccount({ vault, registryUrl: () => REGISTRY, openExternal, fetch: fetchImpl, cloud, confirmPublish, loginTimeoutMs: 50 })
  return { account, calls, assertions, openExternal, confirmPublish }
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('base64url')

function exchangeAnswer(call: Call): { status: number; body: unknown } | null {
  if (!call.url.endsWith('/api/cli/cloud-exchange')) return null
  const body = call.body as { scope: string; namespace: string | null }
  return body.scope === 'publish'
    ? { status: 200, body: { token: PUBLISHER_TOKEN, scope: 'publisher', namespace: body.namespace, expires_at: '2099-01-01T00:00:00Z' } }
    : { status: 200, body: { token: ACCOUNT_TOKEN, scope: 'account', namespace: null, expires_at: '2099-01-01T00:00:00Z' } }
}

describe('Cloud sign-in, account scope', () => {
  it('exchanges an assertion bound to its own verifier, with no browser', async () => {
    const { account, calls, assertions, openExternal } = setup({ registry: (call) => exchangeAnswer(call) ?? { status: 404, body: {} } })
    const state = await account.syncCloudAccount()
    expect(state.signedIn.account).toBe(true)
    expect(state.cloudMemberId).toBe('m_1')
    expect(openExternal).not.toHaveBeenCalled()
    expect(assertions).toHaveLength(1)
    expect(assertions[0]).toMatchObject({ scope: 'account', namespace: null })
    const exchange = calls.find((call) => call.url === `${REGISTRY}/api/cli/cloud-exchange`)!
    const body = exchange.body as { assertion: string; code_verifier: string; scope: string }
    expect(body.assertion).toBe(ASSERTION)
    expect(sha256(body.code_verifier)).toBe(assertions[0].challenge)
    expect(vault.token(REGISTRY, 'account')).toBe(ACCOUNT_TOKEN)
    expect(JSON.stringify(state)).not.toContain(ACCOUNT_TOKEN)
  })

  it('does nothing, and opens no browser, when the Cloud path is unavailable', async () => {
    const cases: Setup[] = [
      { identity: null, registry: () => ({ status: 500, body: {} }) },
      { assertion: () => ({ ok: false, code: 'AUTH_REQUIRED', message: 'sign in' }), registry: () => ({ status: 500, body: {} }) },
      { assertion: () => ({ ok: false, code: 'ASSERTION_DISABLED', message: 'off' }), registry: () => ({ status: 500, body: {} }) },
      { registry: () => ({ status: 404, body: { detail: 'Not Found' } }) },
      { registry: () => ({ status: 401, body: { detail: { code: 'ASSERTION_INVALID', message: 'unknown kid' } } }) },
    ]
    for (const options of cases) {
      const { account, openExternal } = setup(options)
      const state = await account.syncCloudAccount()
      expect(state.signedIn.account).toBe(false)
      expect(openExternal).not.toHaveBeenCalled()
    }
  })

  it('keeps an existing sign-in and asks for no assertion', async () => {
    vault.saveToken(REGISTRY, 'account', ACCOUNT_TOKEN, '2099-01-01T00:00:00Z', null)
    const { account, assertions } = setup({ registry: () => ({ status: 500, body: {} }) })
    expect((await account.syncCloudAccount()).signedIn.account).toBe(true)
    expect(assertions).toHaveLength(0)
  })

  it('forgets tokens exchanged for a different Cloud account', async () => {
    vault.saveToken(REGISTRY, 'publisher', PUBLISHER_TOKEN, '2099-01-01T00:00:00Z', 'old-ns')
    vault.setCloudMember(REGISTRY, 'm_other')
    const { account } = setup({ registry: (call) => exchangeAnswer(call) ?? { status: 404, body: {} } })
    const state = await account.syncCloudAccount()
    expect(state.signedIn.publisher).toBe(false)
    expect(state.signedIn.account).toBe(true)
    expect(state.cloudMemberId).toBe('m_1')
  })

  it('a refusal that is not about the assertion is an error, not a silent fallback', async () => {
    const { account } = setup({ registry: () => ({ status: 500, body: { detail: 'boom' } }) })
    await expect(account.syncCloudAccount()).rejects.toThrow(/sign-in failed \(500/)
  })
})

describe('Cloud sign-in, publish scope', () => {
  function publishRegistry(namespaces: string[]) {
    return (call: Call): { status: number; body: unknown } => {
      const exchanged = exchangeAnswer(call)
      if (exchanged) return exchanged
      if (call.url.endsWith('/api/developer/me/namespaces')) return { status: 200, body: { namespaces } }
      if (call.url.endsWith('/api/publisher/me/key')) return { status: 200, body: {} }
      return { status: 404, body: {} }
    }
  }

  it('asks the native confirmation, then exchanges for the chosen namespace and registers the key', async () => {
    const { account, calls, assertions, confirmPublish, openExternal } = setup({
      registry: publishRegistry(['acme', 'beta']),
      confirm: async () => 'beta',
    })
    const state = await account.signIn('publish')
    expect(confirmPublish).toHaveBeenCalledWith({ accountName: 'Neo', memberId: 'm_1', namespaces: ['acme', 'beta'] })
    expect(assertions.map((a) => [a.scope, a.namespace])).toEqual([['account', null], ['publish', 'beta']])
    expect(state.signedIn.publisher).toBe(true)
    expect(state.namespace).toBe('beta')
    expect(state.keyRegistered).toBe(true)
    expect(openExternal).not.toHaveBeenCalled()
    expect(calls.find((call) => call.url.endsWith('/api/developer/me/namespaces'))?.auth).toBe(`Bearer ${ACCOUNT_TOKEN}`)
  })

  it('grants nothing when the confirmation is cancelled', async () => {
    const { account, assertions } = setup({ registry: publishRegistry(['acme']), confirm: async () => null })
    await expect(account.signIn('publish')).rejects.toThrow(/not granted/)
    expect(assertions.filter((a) => a.scope === 'publish')).toHaveLength(0)
    expect(vault.token(REGISTRY, 'publisher')).toBeNull()
  })

  it('refuses a namespace the Registry did not offer', async () => {
    const { account } = setup({ registry: publishRegistry(['acme']), confirm: async () => 'evil' })
    await expect(account.signIn('publish')).rejects.toThrow(/not offered/)
  })

  it('passes the Registry qualification refusal through', async () => {
    const { account } = setup({
      registry: (call) => {
        if (call.url.endsWith('/api/cli/cloud-exchange') && (call.body as { scope: string }).scope === 'publish') {
          return { status: 403, body: { detail: { code: 'QUALIFICATION_REQUIRED', message: 'not approved' } } }
        }
        return publishRegistry(['acme'])(call)
      },
    })
    await expect(account.signIn('publish')).rejects.toThrow(/403 QUALIFICATION_REQUIRED/)
    expect(vault.token(REGISTRY, 'publisher')).toBeNull()
  })

  it('falls back to the browser when the Registry has no Cloud sign-in', async () => {
    const { account, openExternal, confirmPublish } = setup({ registry: () => ({ status: 404, body: { detail: 'Not Found' } }) })
    // The browser flow then times out in this test: what matters is that it was started.
    await expect(account.signIn('publish')).rejects.toThrow(/timed out/)
    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(String(openExternal.mock.calls[0][0])).toContain('/cli/authorize?')
    expect(confirmPublish).not.toHaveBeenCalled()
  })

  it('falls back to the browser when not signed in to Navide Cloud', async () => {
    const { account, openExternal } = setup({ identity: null, registry: () => ({ status: 500, body: {} }) })
    await expect(account.signIn('account')).rejects.toThrow(/timed out/)
    expect(openExternal).toHaveBeenCalledTimes(1)
  })
})

describe('publishConfirmDialog', () => {
  it('defaults to Cancel and maps each button to its namespace', () => {
    const { options, namespaceFor } = publishConfirmDialog({ accountName: 'Neo', memberId: 'm_1', namespaces: ['acme', 'beta'] }, 'zh-TW')
    expect(options.buttons).toEqual(['以 acme 允許', '以 beta 允許', '取消'])
    expect(options.defaultId).toBe(2)
    expect(options.cancelId).toBe(2)
    expect(options.detail).toContain('Neo (m_1)')
    expect([namespaceFor(0), namespaceFor(1), namespaceFor(2), namespaceFor(-1)]).toEqual(['acme', 'beta', null, null])
  })

  it('falls back to English for a locale without a table', () => {
    expect(publishConfirmDialog({ accountName: '', memberId: 'm_1', namespaces: ['acme'] }, 'ko-KR').options.buttons).toEqual(['Allow as acme', 'Cancel'])
  })
})
