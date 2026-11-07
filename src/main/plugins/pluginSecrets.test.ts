import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { capabilitiesV1, parseManifestV2, type PluginSystemNamespace } from '../../../packages/plugin-contracts/src/index'
import { MAX_SECRETS_PER_PLUGIN, MAX_SECRET_VALUE_BYTES } from '../../../packages/plugin-contracts/src/secrets'
import { executionPolicyAllows, planPublicCapabilityCall } from './pluginCapabilityBroker'
import { PUBLIC_CAPABILITY_CATALOG } from './pluginCapabilityCatalog'
import { manifestV2CapabilityPolicy } from './pluginPermissions'
import { activityRowFor } from './pluginActivity'
import { HOST_DEFAULT_EXECUTION_POLICY } from './executionPolicy'
import { SENSITIVE_CAPABILITIES } from './pluginVerify'
import { computeDisclosure, type DisclosureManifestInput } from '../../shared/pluginDisclosure'
import {
  PluginSecretStore,
  PluginSecretsLimitError,
  SECRETS_METHODS,
  redactSecretValues,
  validateSecretsOperation,
  validateSecretsRequest,
  type PluginSecretsCrypto,
} from './pluginSecrets'

// Test values are built at run time, never written out as literals.
const fakeSecret = (label: string): string => ['sk', 'test', label, String(process.pid)].join('-')

/** Reversible stand-in for safeStorage: the stored text never contains the plain value. */
function fakeCrypto(available = true): PluginSecretsCrypto & { available: boolean } {
  return {
    available,
    encrypt: (plain) => `enc:${Buffer.from([...plain].reverse().join(''), 'utf8').toString('base64')}`,
    decrypt: (enc) => {
      if (!enc.startsWith('enc:')) throw new Error('not ciphertext')
      return [...Buffer.from(enc.slice(4), 'base64').toString('utf8')].reverse().join('')
    },
  }
}

const roots: string[] = []
function store(crypto = fakeCrypto()): { store: PluginSecretStore; root: string } {
  const parent = mkdtempSync(join(tmpdir(), 'navide-plugin-secrets-'))
  roots.push(parent)
  const root = join(parent, 'plugin-secrets')
  return { store: new PluginSecretStore(root, crypto), root }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('plugin secret store', () => {
  it('writes only ciphertext, owner-only, and reads the value back', () => {
    const { store: secrets, root } = store()
    const value = fakeSecret('a')
    expect(secrets.set('acme.tokens', 'API_KEY', value)).toEqual({ ok: true })
    const file = join(root, 'acme.tokens.json')
    const text = readFileSync(file, 'utf8')
    expect(text).not.toContain(value)
    expect(text).toContain('API_KEY')
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(statSync(root).mode & 0o777).toBe(0o700)
    }
    expect(readdirSync(root)).toEqual(['acme.tokens.json'])
    expect(secrets.get('acme.tokens', 'API_KEY')).toEqual({ present: true, value })
    expect(secrets.get('acme.tokens', 'OTHER')).toEqual({ present: false })
  })

  it('keeps every plugin in its own namespace', () => {
    const { store: secrets } = store()
    const value = fakeSecret('b')
    secrets.set('acme.tokens', 'API_KEY', value)
    expect(secrets.get('other.plugin', 'API_KEY')).toEqual({ present: false })
    expect(secrets.list('other.plugin')).toEqual({ names: [] })
    secrets.set('other.plugin', 'API_KEY', fakeSecret('c'))
    expect(secrets.get('acme.tokens', 'API_KEY')).toEqual({ present: true, value })
    secrets.clear('other.plugin')
    expect(secrets.get('acme.tokens', 'API_KEY')).toEqual({ present: true, value })
  })

  it('keys the file by plugin id only, so another version of the package reads the same secrets', () => {
    const crypto = fakeCrypto()
    const { store: first, root } = store(crypto)
    const value = fakeSecret('d')
    first.set('acme.tokens', 'API_KEY', value)
    const restarted = new PluginSecretStore(root, crypto)
    expect(restarted.get('acme.tokens', 'API_KEY')).toEqual({ present: true, value })
  })

  it('refuses instead of writing plain text when secure storage is unavailable', () => {
    const crypto = fakeCrypto(false)
    const { store: secrets, root } = store(crypto)
    const unavailable = { ok: false, code: 'SECRETS_UNAVAILABLE' }
    expect(secrets.set('acme.tokens', 'API_KEY', fakeSecret('e'))).toEqual(unavailable)
    expect(secrets.get('acme.tokens', 'API_KEY')).toEqual(unavailable)
    expect(() => readdirSync(root)).toThrow()
    expect(secrets.values('acme.tokens')).toEqual([])
  })

  it('answers unavailable for a value that no longer decrypts', () => {
    const crypto = fakeCrypto()
    const { store: secrets } = store(crypto)
    secrets.set('acme.tokens', 'API_KEY', fakeSecret('f'))
    crypto.decrypt = () => { throw new Error('keychain changed') }
    expect(secrets.get('acme.tokens', 'API_KEY')).toEqual({ ok: false, code: 'SECRETS_UNAVAILABLE' })
  })

  it('lists names only, never values', () => {
    const { store: secrets } = store()
    const value = fakeSecret('g')
    secrets.set('acme.tokens', 'b_key', value)
    secrets.set('acme.tokens', 'a_key', value)
    const listed = secrets.list('acme.tokens')
    expect(listed).toEqual({ names: ['a_key', 'b_key'] })
    expect(JSON.stringify(listed)).not.toContain(value)
  })

  it('deletes one name, and the file when none is left', () => {
    const { store: secrets, root } = store()
    secrets.set('acme.tokens', 'API_KEY', fakeSecret('h'))
    expect(secrets.delete('acme.tokens', 'MISSING')).toEqual({ ok: true })
    expect(secrets.delete('acme.tokens', 'API_KEY')).toEqual({ ok: true })
    expect(readdirSync(root)).toEqual([])
    expect(secrets.count('acme.tokens')).toBe(0)
  })

  it('limits value size and count', () => {
    const { store: secrets } = store()
    expect(() => secrets.set('acme.tokens', 'BIG', 'x'.repeat(MAX_SECRET_VALUE_BYTES + 1))).toThrow(PluginSecretsLimitError)
    for (let index = 0; index < MAX_SECRETS_PER_PLUGIN; index++) secrets.set('acme.tokens', `K${index}`, fakeSecret(String(index)))
    expect(() => secrets.set('acme.tokens', 'ONE_MORE', fakeSecret('i'))).toThrow(PluginSecretsLimitError)
    // Replacing an existing name is not a new secret.
    expect(secrets.set('acme.tokens', 'K0', fakeSecret('j'))).toEqual({ ok: true })
  })

  it('never resolves a plugin id to a path outside its directory', () => {
    const { store: secrets } = store()
    expect(() => secrets.set('../escape', 'API_KEY', fakeSecret('k'))).toThrow(/invalid plugin id/)
    expect(() => secrets.list('acme/../../x')).toThrow(/invalid plugin id/)
  })
})

describe('secrets request validation', () => {
  it.each([
    ['secrets.set', { name: 'API_KEY', value: '' }],
    ['secrets.get', { name: 'a.b-c_1' }],
    ['secrets.delete', { name: 'API_KEY' }],
    ['secrets.list', {}],
  ])('accepts %s %j', (address, args) => {
    expect(validateSecretsRequest(address, args)).toBe(true)
  })

  it.each([
    ['secrets.set', { name: 'API_KEY' }],
    ['secrets.set', { name: 'API_KEY', value: 1 }],
    ['secrets.get', { name: '' }],
    ['secrets.get', { name: 'has space' }],
    ['secrets.get', { name: 'x'.repeat(129) }],
    ['secrets.get', { name: 'API_KEY', pluginId: 'other.plugin' }],
    ['secrets.list', { pluginId: 'other.plugin' }],
    ['secrets.export', {}],
  ])('refuses %s %j', (address, args) => {
    expect(validateSecretsRequest(address, args)).toBe(false)
  })

  it('validates Bridge operations by name', () => {
    expect(validateSecretsOperation('get', { name: 'API_KEY' })).toBe(true)
    expect(validateSecretsOperation('dump', {})).toBe(false)
  })
})

describe('secrets catalog, disclosure and policy', () => {
  const binding = { pluginId: 'acme.tokens', packageVersion: '1.0.0', workspaceId: 'workspace-1', instanceId: 'instance-1', audience: 'main' }
  const call = (address: string, args: Record<string, unknown> = {}) => {
    const [ns, method] = address.split('.')
    return { pluginId: binding.pluginId, ns: ns!, method: method!, args, reqId: `req-${address}` }
  }
  const context = (system: PluginSystemNamespace[], overrides: Record<string, unknown> = {}) => ({
    publisherEligible: false,
    userGrant: { packageVersion: binding.packageVersion, system },
    runtimeBinding: binding,
    ...overrides,
  })
  const agent = { kind: 'agent', source: 'mcp', id: 'agent-1' } as const
  const snapshot = (mode: 'full' | 'allowlist' | 'denylist', system: string[]) =>
    ({ policy: { schemaVersion: 1, mode, system, shell: [] }, revision: 1, state: 'user' }) as never

  it('lists four plugin-scoped public methods, since API 1.3.0, in both catalogs', () => {
    expect(SECRETS_METHODS).toEqual(['secrets.set', 'secrets.get', 'secrets.delete', 'secrets.list'])
    const json = capabilitiesV1 as { methods: Array<{ address: string; since: string; permission: unknown }> }
    for (const address of SECRETS_METHODS) {
      expect(PUBLIC_CAPABILITY_CATALOG[address]).toMatchObject({
        kind: 'method', namespace: 'secrets', scope: 'plugin', eligibility: 'public',
      })
      const entry = json.methods.find((method) => method.address === address)
      expect(entry?.since).toBe('1.3.0')
      expect(entry?.permission).toEqual({ id: 'system', access: 'secrets', scope: 'plugin' })
    }
  })

  it('needs the declaration and the user grant, without a workspace', () => {
    const policy = manifestV2CapabilityPolicy({ system: ['secrets'] })
    expect(planPublicCapabilityCall(call('secrets.get', { name: 'API_KEY' }), policy, context(['secrets'], {
      runtimeBinding: { ...binding, workspaceId: null },
    }))).toMatchObject({ kind: 'allow', plan: { address: 'secrets.get', scope: 'plugin' } })
    expect(planPublicCapabilityCall(call('secrets.get', { name: 'API_KEY' }), policy, context(['ui'])))
      .toMatchObject({ kind: 'deny', response: { error: { code: 'CAPABILITY_DENIED' } } })
    expect(planPublicCapabilityCall(call('secrets.get', { name: 'API_KEY' }), manifestV2CapabilityPolicy({ system: ['ui'] }), context(['secrets'])))
      .toMatchObject({ kind: 'deny' })
    expect(planPublicCapabilityCall(call('secrets.get', { name: 'API_KEY', pluginId: 'other.plugin' }), policy, context(['secrets'])))
      .toMatchObject({ kind: 'deny', response: { error: { code: 'INVALID_ARGUMENT' } } })
  })

  it('never gives an agent secrets by omission, and the Host default names them', () => {
    expect(executionPolicyAllows(agent, snapshot('denylist', []), 'secrets')).toBe(false)
    expect(executionPolicyAllows(agent, snapshot('allowlist', ['fs']), 'secrets')).toBe(false)
    expect(executionPolicyAllows(agent, snapshot('allowlist', ['secrets']), 'secrets')).toBe(true)
    expect(executionPolicyAllows(agent, snapshot('full', []), 'secrets')).toBe(true)
    expect(HOST_DEFAULT_EXECUTION_POLICY.system).toContain('secrets')
  })

  it('discloses secrets as high risk and asks the second confirmation', () => {
    const disclosure = computeDisclosure({
      schemaVersion: 2, id: 'acme.tokens', permissions: { system: ['secrets'] },
    } as unknown as DisclosureManifestInput)
    expect(disclosure.risk.level).toBe('high')
    expect(disclosure.risk.reasons).toContainEqual(expect.objectContaining({ key: 'system.secrets' }))
    expect(disclosure.summary.clauses).toContainEqual({ key: 'secrets', params: {} })
    expect(SENSITIVE_CAPABILITIES).toContain('secrets')
  })

  it('accepts secrets in a manifest', () => {
    const manifest = parseManifestV2({
      schemaVersion: 2, apiVersion: '^1.3.0', id: 'acme.tokens', name: 'Tokens', version: '1.0.0', publisher: 'acme',
      permissions: { system: ['fs', 'ui', 'aiCli', 'web', 'agents', 'agentMessages', 'secrets'] },
      marketplace: { description: 'Tokens', license: 'MIT' },
      contributes: { views: [{ id: 'main', kind: 'custom', location: 'window', title: 'Tokens', entry: 'index.html' }] },
    })
    expect(manifest.permissions.system).toContain('secrets')
  })

  it('records only the address in Activity, never the name or value', () => {
    const value = fakeSecret('l')
    const row = activityRowFor({
      pluginId: binding.pluginId,
      packageVersion: binding.packageVersion,
      workspace: '/workspace',
      call: call('secrets.set', { name: 'API_KEY', value }),
      response: { reqId: 'req-secrets.set', ok: true, result: { ok: true } },
      at: 1,
    })
    expect(row.address).toBe('secrets.set')
    expect(JSON.stringify(row)).not.toContain(value)
  })
})

describe('agent tool result redaction', () => {
  it('removes the plugin secret from results and error text, keeping the JSON shape', () => {
    const value = fakeSecret('m')
    const response = {
      ok: true,
      result: { text: `token=${value}`, nested: [value, 1, { [value]: true }], count: 2 },
      meta: { durationMs: 1, resultBytes: 10, crossWorkspace: false },
    }
    const redacted = redactSecretValues(response, [value])
    expect(JSON.stringify(redacted)).not.toContain(value)
    expect(redacted.result.count).toBe(2)
    expect(redacted.result.nested[1]).toBe(1)
    expect(redactSecretValues({ ok: false, error: `failed with ${value}` }, [value]).error).not.toContain(value)
  })

  it('returns the same object when nothing matches', () => {
    const response = { ok: true, result: { a: '1,2' } }
    expect(redactSecretValues(response, [fakeSecret('n')])).toBe(response)
    expect(redactSecretValues(response, [])).toBe(response)
  })

  it('cannot break the JSON structure with a value that looks like syntax', () => {
    const response = { ok: true, result: [1, 2, { a: '{"x":1}' }] }
    expect(redactSecretValues(response, ['1,2', '{', '"'])).toEqual({ ok: true, result: [1, 2, { a: '[secret redacted][secret redacted]x[secret redacted]:1}' }] })
  })
})
