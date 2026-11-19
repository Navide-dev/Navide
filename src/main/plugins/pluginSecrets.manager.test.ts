// The Host never hands a plugin's own secrets to an agent: every agent tool
// answer (inline or chunked, result or error text) is redacted against the
// package's stored values before it goes back to the core.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FrontendPluginManager } from './frontendPluginManager'
import { PluginSecretStore, type PluginSecretsCrypto } from './pluginSecrets'

const fakeSecret = (label: string): string => ['sk', 'live', label, String(process.pid)].join('_')

const crypto: PluginSecretsCrypto = {
  available: async () => true,
  encrypt: async (plain) => Buffer.from(plain, 'utf8').toString('base64'),
  decrypt: async (enc) => Buffer.from(enc, 'base64').toString('utf8'),
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type Redact = (pluginId: string, response: unknown) => Promise<unknown>

async function managerWithSecret(pluginId: string, value: string): Promise<{ manager: FrontendPluginManager; redact: Redact }> {
  const root = mkdtempSync(join(tmpdir(), 'navide-plugin-secrets-manager-'))
  roots.push(root)
  const store = new PluginSecretStore(join(root, 'plugin-secrets'), crypto)
  await store.set(pluginId, 'API_KEY', value)
  const manager = new FrontendPluginManager()
  manager.setPluginSecretStore(store)
  const redact = (manager as unknown as { redactAgentToolSecrets: Redact }).redactAgentToolSecrets.bind(manager)
  return { manager, redact }
}

const meta = { durationMs: 1, resultBytes: 1, crossWorkspace: false }

describe('agent tool answers never carry plugin secrets', () => {
  it('redacts an inline result and a failure message', async () => {
    const value = fakeSecret('a')
    const { redact } = await managerWithSecret('acme.tokens', value)
    const result = await redact('acme.tokens', { ok: true, result: { echoed: value, ok: 1 }, meta })
    expect(JSON.stringify(result)).not.toContain(value)
    expect(result).toMatchObject({ ok: true, result: { ok: 1 } })
    const failure = await redact('acme.tokens', { ok: false, error_code: 'PLUGIN_TOOL_FAILED', error: `bad key ${value}`, meta })
    expect(JSON.stringify(failure)).not.toContain(value)
  })

  it('joins a chunked result, redacts it and answers inline', async () => {
    const value = fakeSecret('b')
    const { redact } = await managerWithSecret('acme.tokens', value)
    const text = JSON.stringify({ token: value, filler: 'x'.repeat(10) })
    const half = Math.floor(text.length / 2)
    const pieces = [text.slice(0, half), text.slice(half)]
    const answer = (await redact('acme.tokens', {
      ok: true,
      resultText: { chunks: 2, bytes: text.length, piece: (seq: number) => pieces[seq]! },
      meta,
    })) as Record<string, unknown>
    expect(answer.resultText).toBeUndefined()
    expect(JSON.stringify(answer)).not.toContain(value)
    expect(answer).toMatchObject({ ok: true, result: { filler: 'x'.repeat(10) } })
  })

  it("leaves another plugin's answer alone and keeps the same object when nothing matches", async () => {
    const value = fakeSecret('c')
    const { redact } = await managerWithSecret('acme.tokens', value)
    const unrelated = { ok: true, result: { text: 'hello' }, meta }
    expect(await redact('acme.tokens', unrelated)).toBe(unrelated)
    // The other package has no secrets of its own, so nothing is looked for.
    const other = { ok: true, result: { text: value }, meta }
    expect(await redact('other.plugin', other)).toBe(other)
  })

  it('counts and clears a package’s secrets only on request, and tells the user each time', async () => {
    const value = fakeSecret('d')
    const { manager } = await managerWithSecret('acme.tokens', value)
    const notices: unknown[] = []
    manager.setPluginSecretsNoticeHandler((notice) => notices.push(notice))
    expect(manager.pluginSecretCount('acme.tokens')).toBe(1)
    expect(manager.pluginSecretCount('other.plugin')).toBe(0)
    manager.clearPluginSecrets('acme.tokens')
    expect(manager.pluginSecretCount('acme.tokens')).toBe(0)
    expect(notices).toEqual([{ kind: 'cleared', pluginId: 'acme.tokens', count: 1 }])
    // Nothing left to delete: nothing to tell.
    manager.clearPluginSecrets('acme.tokens')
    expect(notices).toHaveLength(1)
  })

  it('isolates the secrets after an identity change and tells the user once', async () => {
    const value = fakeSecret('e')
    const { manager } = await managerWithSecret('acme.tokens', value)
    let identity = 'registry'
    manager.setPluginSecretIdentityResolver(() => identity)
    const run = (manager as unknown as {
      runPluginSecrets: (pluginId: string, operation: string, args: Record<string, unknown>) => Promise<unknown>
    }).runPluginSecrets.bind(manager)
    expect(await run('acme.tokens', 'set', { name: 'API_KEY', value })).toEqual({ ok: true })
    const notices: unknown[] = []
    manager.setPluginSecretsNoticeHandler((notice) => notices.push(notice))
    identity = 'developer-unpacked'
    expect(await run('acme.tokens', 'get', { name: 'API_KEY' })).toEqual({ ok: false, code: 'SECRETS_IDENTITY_MISMATCH' })
    expect(await run('acme.tokens', 'list', {})).toEqual({ ok: false, code: 'SECRETS_IDENTITY_MISMATCH' })
    expect(notices).toEqual([{ kind: 'identityMismatch', pluginId: 'acme.tokens' }])
    expect(manager.pluginSecretCount('acme.tokens')).toBe(1)
  })
})
