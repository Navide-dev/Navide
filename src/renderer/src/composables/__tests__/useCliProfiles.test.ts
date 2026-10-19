// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import {
  createCliAccountSwitchHandler,
  forcedRestartAgentKey,
  paneNeedsAccountRestart,
  runAccountRestartBatch,
  useCliProfiles,
  type CliProfile,
  type SetDefaultResult,
} from '../useCliProfiles'
import { createMockBackend, withScope, flush } from './mockBackend'
import { i18n } from '@navide/plugin-ui/foundation'

function profile(id: string, agentKey: string, name: string): CliProfile {
  return { id, agentKey, name, createdAt: '2026-07-01T00:00:00Z' }
}

const SUPPORTED = ['claude', 'codex', 'kimi', 'grok']

describe('useCliProfiles', () => {
  it('loads profiles/defaults/supported agents on connect', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', {
      profiles: [profile('p1', 'claude', 'Work')],
      defaults: { claude: 'p1' },
      supported_agents: SUPPORTED,
    })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    expect(result.profiles.value.map((p) => p.id)).toEqual(['p1'])
    expect(result.defaults.value.claude).toBe('p1')
    expect(result.supportedAgents.value).toEqual(SUPPORTED)
    expect(result.loaded.value).toBe(true)
    scope.stop()
  })

  it('ensureLoaded shares the initial load and does not re-fetch once loaded', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await result.ensureLoaded()
    await flush()
    expect(result.loaded.value).toBe(true)
    await result.ensureLoaded()
    expect(mock.sent.filter((s) => s.type === 'cli_profiles.list')).toHaveLength(1)
    scope.stop()
  })

  it('create sends snake_case payload and adopts the returned lists', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
    const created = profile('p2', 'codex', 'Personal')
    mock.setResponse('cli_profiles.create', {
      profile: created,
      profiles: [created],
      defaults: {},
    })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    const out = await result.create('codex', 'Personal')
    expect(out?.id).toBe('p2')
    const call = mock.sent.find((s) => s.type === 'cli_profiles.create')
    expect(call?.payload).toEqual({ agent_key: 'codex', name: 'Personal' })
    expect(result.profiles.value.map((p) => p.id)).toEqual(['p2'])
    scope.stop()
  })

  it('set_default sends profile_id (null for built-in Default) and updates defaults', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', {
      profiles: [profile('p1', 'claude', 'Work')],
      defaults: { claude: 'p1' },
      supported_agents: SUPPORTED,
    })
    mock.setResponse('cli_profiles.set_default', { defaults: { claude: null } })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    const res = await result.setDefault('claude', null)
    expect(res).toEqual({ ok: true, needsLogin: false })
    const call = mock.sent.find((s) => s.type === 'cli_profiles.set_default')
    expect(call?.payload).toEqual({ agent_key: 'claude', profile_id: null })
    expect(result.defaultProfileId('claude')).toBe(null)
    scope.stop()
  })

  it('set_default forwards force: true in the payload', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
    mock.setResponse('cli_profiles.set_default', { defaults: { claude: 'p1' } })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    const res = await result.setDefault('claude', 'p1', { force: true })
    expect(res).toEqual({ ok: true, needsLogin: false })
    const call = mock.sent.find((s) => s.type === 'cli_profiles.set_default')
    expect(call?.payload).toEqual({ agent_key: 'claude', profile_id: 'p1', force: true })
    scope.stop()
  })

  it('set_default sends the account prompt\'s switch-back with its live-login fingerprint', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
    mock.setResponse('cli_profiles.set_default', { defaults: { claude: 'p1' } })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    await result.setDefault('claude', 'p1', { restoreLive: { liveFingerprint: 'fp-b' } })
    const call = mock.sent.find((s) => s.type === 'cli_profiles.set_default')
    expect(call?.payload).toEqual({
      agent_key: 'claude', profile_id: 'p1', restore_live: true, restore_live_fingerprint: 'fp-b',
    })
    scope.stop()
  })

  it('set_default tells a stale switch-back (LIVE_CHANGED) that nothing was switched', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
    mock.setResponse('cli_profiles.set_default', null as unknown as object, {
      ok: false,
      error: { code: 'LIVE_CHANGED', message: 'another claude login is live since this prompt; nothing was switched' },
    })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    const res = await result.setDefault('claude', 'p1', { restoreLive: { liveFingerprint: 'fp-b' } })
    expect(res).toMatchObject({ ok: false, code: 'LIVE_CHANGED' })
    expect(res.ok ? '' : res.message).toContain('nothing was switched')
    scope.stop()
  })

  it('set_default maps PANES_RUNNING to code + count without setting the banner error', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
    mock.setResponse('cli_profiles.set_default', null as unknown as object, {
      ok: false,
      error: { code: 'PANES_RUNNING', message: 'panes running', details: { count: 2 } },
    })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    const res = await result.setDefault('claude', 'p1')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.code).toBe('PANES_RUNNING')
      expect(res.count).toBe(2)
      expect(res.message).toBeTruthy()
    }
    // The confirm flow (or an alert) handles it — never the pane banner.
    expect(result.error.value).toBe('')
    scope.stop()
  })

  it('set_default maps SWITCH_RATE_LIMITED to a message without setting the banner error', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
    mock.setResponse('cli_profiles.set_default', null as unknown as object, {
      ok: false,
      error: { code: 'SWITCH_RATE_LIMITED', message: 'too many', details: { retryAfter: 42.3 } },
    })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    const res = await result.setDefault('claude', 'p1')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.code).toBe('SWITCH_RATE_LIMITED')
      // Rounded up: telling the user to wait 42s when 42.3s remain would
      // send them back one retry too early.
      expect(res.message).toContain('43')
    }
    // The limit clears by itself — nothing for a banner to report.
    expect(result.error.value).toBe('')
    scope.stop()
  })

  it('set_default maps LOGIN_IN_PROGRESS to the string delete() already localizes', async () => {
    // Every sibling refusal on this path is localized; this one used to fall
    // through to the backend's untranslated English. Since 599d79bc the pane
    // toasts whatever message it gets, so the raw string would surface as-is.
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
    mock.setResponse('cli_profiles.set_default', null as unknown as object, {
      ok: false,
      error: {
        code: 'LOGIN_IN_PROGRESS',
        message: 'a claude sign-in for this account is still running; finish or close its pane first',
      },
    })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    const res = await result.setDefault('claude', 'p1')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.code).toBe('LOGIN_IN_PROGRESS')
      expect(res.message).toBeTruthy()
      expect(res.message).not.toContain('finish or close its pane first')
      expect(result.error.value).toBe(res.message)
    }
    scope.stop()
  })

  it('set_default maps PROFILE_SWAP_FAILED to a localized error', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
    mock.setResponse('cli_profiles.set_default', null as unknown as object, {
      ok: false,
      error: { code: 'PROFILE_SWAP_FAILED', message: 'swap failed, rolled back' },
    })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    const res = await result.setDefault('claude', 'p1')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.code).toBe('PROFILE_SWAP_FAILED')
      expect(res.message).toBeTruthy()
      expect(result.error.value).toBe(res.message)
    }
    scope.stop()
  })

  it('create forwards the provider scope the caller picked, never one of its own', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', {
      profiles: [], defaults: {}, supported_agents: [...SUPPORTED, 'opencode'],
      account_capabilities: {
        opencode: { agentKey: 'opencode', supported: true, authScope: 'opencode', method: 'restart', evidence: 'source', platforms: ['darwin'], scopes: ['anthropic', 'openai'], resume: 'native', todo: '' },
      },
    })
    const created = { ...profile('p9', 'opencode', 'Account 2'), scope: 'openai' }
    mock.setResponse('cli_profiles.create', { profile: created, profiles: [created], defaults: {} })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    expect(result.scopesFor('opencode')).toEqual(['anthropic', 'openai'])
    expect(result.scopesFor('claude')).toEqual([])
    expect(result.capabilityFor('opencode')?.platforms).toEqual(['darwin'])
    await result.create('opencode', 'Account 2', 'openai')
    expect(mock.sent.find((s) => s.type === 'cli_profiles.create')?.payload).toEqual({ agent_key: 'opencode', name: 'Account 2', scope: 'openai' })
    mock.sent.length = 0
    await result.create('codex', 'Personal', null)
    expect(mock.sent.find((s) => s.type === 'cli_profiles.create')?.payload).toEqual({ agent_key: 'codex', name: 'Personal' })
    scope.stop()
  })

  it.each([
    ['UNKNOWN_SCOPE', {}, 'cli-account.preflight-unknown-scope'],
    ['SHADOWED_BY_ENV', { shadowedBy: ['ANTHROPIC_API_KEY'] }, 'cli-account.preflight-shadowed-by-env'],
    ['PLATFORM_UNSUPPORTED', {}, 'cli-account.preflight-platform-unsupported'],
    ['UNSUPPORTED', {}, 'cli-account.preflight-unsupported'],
    ['IDENTITY_UNKNOWN', {}, 'cli-account.preflight-identity-unknown'],
    ['UNRECONCILED_STATE', { transactionId: 'tx' }, 'cli-account.preflight-unreconciled'],
    ['CREDENTIAL_SOURCE_UNKNOWN', { reason: 'uncertain_env' }, 'cli-account.preflight-credential-source-unknown'],
  ])('set_default turns a %s preflight refusal into a sentence, never the raw code', async (code, details, key) => {
    const { i18n } = await import('@navide/plugin-ui/foundation')
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
    mock.setResponse('cli_profiles.set_default', null as unknown as object, {
      ok: false, error: { code, message: code, details },
    })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    const res = await result.setDefault('claude', 'p1')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.code).toBe(code)
      const expected = i18n.global.t(key, { agent: 'Claude Code (Anthropic)', vars: 'ANTHROPIC_API_KEY' })
      expect(res.message).toBe(expected)
      expect(res.message).not.toContain(code)
      expect(res.message).not.toContain('cli-account.')
      expect(result.error.value).toBe(expected)
    }
    scope.stop()
  })

  it('set_default: LOGIN_IN_PROGRESS with a state, LIVE_DRIFT and adoptedLiveLogin are surfaced as sentences / flags', async () => {
    const { i18n } = await import('@navide/plugin-ui/foundation')
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    mock.setResponse('cli_profiles.set_default', null as unknown as object, {
      ok: false, error: { code: 'LOGIN_IN_PROGRESS', message: 'LOGIN_IN_PROGRESS', details: { agentKey: 'kilo', profileId: null, state: 'running' } },
    })
    let res = await result.setDefault('kilo', 'p1')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.message).toBe(i18n.global.t('cli-account.login-in-progress', { agent: 'Kilo Code CLI', state: 'running' }))
      expect(res.message).not.toContain('LOGIN_IN_PROGRESS')
    }

    mock.setResponse('cli_profiles.set_default', null as unknown as object, {
      ok: false, error: { code: 'LIVE_DRIFT', message: 'LIVE_DRIFT', details: { currentSlotId: '__default__', targetSlotId: 'p1' } },
    })
    res = await result.setDefault('kilo', 'p1')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toBe(i18n.global.t('cli-account.live-drift', { agent: 'Kilo Code CLI' }))

    mock.setResponse('cli_profiles.set_default', { defaults: { kilo: 'p1' }, adoptedLiveLogin: true })
    res = await result.setDefault('kilo', 'p1')
    expect(res).toEqual({ ok: true, needsLogin: false, needsLoginReason: undefined, adoptedLiveLogin: true })
    scope.stop()
  })

  it('a Copilot plaintext token store is named as such, whatever the error code', async () => {
    const { i18n } = await import('@navide/plugin-ui/foundation')
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: [...SUPPORTED, 'copilot'] })
    mock.setResponse('cli_profiles.set_default', null as unknown as object, {
      ok: false, error: { code: 'PROFILE_SWAP_FAILED', message: 'CredentialVaultError: copilot storeTokenPlaintext is enabled; refusing to touch the token file' },
    })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()
    const res = await result.setDefault('copilot', 'p1')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toBe(i18n.global.t('cli-account.plaintext-token-store'))
    scope.stop()
  })

  it('loginIsGlobal reads the backend capability and is false when unknown', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', {
      profiles: [], defaults: {}, supported_agents: [...SUPPORTED, 'kilo'],
      account_capabilities: {
        kilo: { agentKey: 'kilo', supported: true, authScope: 'kilo', method: 'restart', evidence: 'source', platforms: [], scopes: [], resume: 'native', todo: '', loginIsolation: 'global' },
        claude: { agentKey: 'claude', supported: true, authScope: 'claude', method: 'hot', evidence: 'source', platforms: [], scopes: [], resume: 'native', todo: '', loginIsolation: 'isolated' },
      },
    })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()
    expect(result.loginIsGlobal('kilo')).toBe(true)
    expect(result.loginIsGlobal('claude')).toBe(false)
    expect(result.loginIsGlobal('codex')).toBe(false)
    scope.stop()
  })

  it('syncs cache from a cli_profiles.changed broadcast', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    mock.emit('cli_profiles.changed', {
      profiles: [profile('p9', 'kimi', 'Alt')],
      defaults: { kimi: 'p9' },
      reason: 'create',
    })
    expect(result.profilesForAgent('kimi').map((p) => p.id)).toEqual(['p9'])
    expect(result.defaultProfileId('kimi')).toBe('p9')
    scope.stop()
  })

  it('loads the Default slots\' aliases and keeps them in sync with the broadcast', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', {
      profiles: [],
      defaults: {},
      defaultNames: { claude: 'Main' },
      supported_agents: SUPPORTED,
    })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    expect(result.defaultNames.value).toEqual({ claude: 'Main' })
    expect(result.aliasFor('claude', null)).toBe('Main')
    expect(result.aliasFor('claude', '__default__')).toBe('Main')
    expect(result.aliasFor('codex', null)).toBeUndefined()

    // Clearing the last alias broadcasts an empty map — it must not be
    // mistaken for "no news" and leave the removed name on screen.
    mock.emit('cli_profiles.changed', { defaultNames: {}, reason: 'rename' })
    expect(result.defaultNames.value).toEqual({})
    expect(result.aliasFor('claude', null)).toBeUndefined()
    scope.stop()
  })

  it('aliasFor tells a user-given name from the generated one', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', {
      profiles: [
        { ...profile('p1', 'claude', 'Work'), nameIsCustom: true },
        profile('p2', 'claude', 'Account 3'),
      ],
      defaults: {},
      supported_agents: SUPPORTED,
    })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    expect(result.aliasFor('claude', 'p1')).toBe('Work')
    // "Account 3" is a placeholder the app minted, not a name the user chose.
    expect(result.aliasFor('claude', 'p2')).toBeUndefined()
    expect(result.aliasFor('claude', 'gone')).toBeUndefined()
    scope.stop()
  })

  it('rename carries the agent key for the built-in Default and adopts the returned aliases', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
    mock.setResponse('cli_profiles.rename', {
      profile: null,
      profiles: [],
      defaults: {},
      defaultNames: { claude: 'Main' },
    })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    // The Default has no profile record, so the backend cannot tell whose
    // Default it is without the agent key.
    await result.rename('__default__', 'Main', 'claude')
    const call = mock.sent.find((s) => s.type === 'cli_profiles.rename')
    expect(call?.payload).toEqual({ id: '__default__', name: 'Main', agentKey: 'claude' })
    expect(result.defaultNames.value).toEqual({ claude: 'Main' })
    scope.stop()
  })

  it('a successful rename clears an earlier error, so a null Default reply reads as success', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
    mock.setResponse('cli_profiles.rename', null as unknown as object, {
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'too long' },
    })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    expect(await result.rename('__default__', 'x', 'claude')).toBeNull()
    expect(result.error.value).toBe('too long')

    mock.setResponse('cli_profiles.rename', {
      profile: null,
      profiles: [],
      defaults: {},
      defaultNames: { claude: 'Main' },
    })
    expect(await result.rename('__default__', 'Main', 'claude')).toBeNull()
    expect(result.error.value).toBe('')
    scope.stop()
  })

  it('renaming a profile slot sends no agent key when none is given', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
    const renamed = { ...profile('p1', 'claude', 'Work'), nameIsCustom: true }
    mock.setResponse('cli_profiles.rename', { profile: renamed, profiles: [renamed], defaults: {} })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    const out = await result.rename('p1', 'Work')
    expect(out?.nameIsCustom).toBe(true)
    expect(mock.sent.find((s) => s.type === 'cli_profiles.rename')?.payload).toEqual({
      id: 'p1',
      name: 'Work',
    })
    expect(result.aliasFor('claude', 'p1')).toBe('Work')
    scope.stop()
  })

  it('clearing a profile alias adopts the row the backend regenerates', async () => {
    const mock = createMockBackend('connected')
    const named = { ...profile('p1', 'claude', 'Work'), nameIsCustom: true }
    mock.setResponse('cli_profiles.list', {
      profiles: [named],
      defaults: {},
      supported_agents: SUPPORTED,
    })
    // What the backend does with an empty name: the custom flag goes and the
    // generated "Account N" comes back (max + 1 over the existing ones).
    const cleared = profile('p1', 'claude', 'Account 2')
    mock.setResponse('cli_profiles.rename', { profile: cleared, profiles: [cleared], defaults: {} })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()
    expect(result.aliasFor('claude', 'p1')).toBe('Work')

    await result.rename('p1', '', 'claude')
    expect(mock.sent.find((s) => s.type === 'cli_profiles.rename')?.payload).toEqual({
      id: 'p1',
      name: '',
      agentKey: 'claude',
    })
    expect(result.aliasFor('claude', 'p1')).toBeUndefined()
    expect(result.findProfile('p1')?.name).toBe('Account 2')

    // Another window clearing it reaches here as a broadcast, not a reply.
    mock.emit('cli_profiles.changed', { profiles: [named], reason: 'rename' })
    expect(result.aliasFor('claude', 'p1')).toBe('Work')
    mock.emit('cli_profiles.changed', { profiles: [cleared], reason: 'rename' })
    expect(result.aliasFor('claude', 'p1')).toBeUndefined()
    scope.stop()
  })

  it('surfaces the error message when a mutation fails', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
    mock.setResponse('cli_profiles.create', null as unknown as object, {
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'name taken' },
    })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    const out = await result.create('claude', 'dup')
    expect(out).toBe(null)
    expect(result.error.value).toBe('name taken')
    scope.stop()
  })

  it('hasProfiles / profilesForAgent partition by agent', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', {
      profiles: [profile('a', 'claude', 'One'), profile('b', 'codex', 'Two')],
      defaults: {},
      supported_agents: SUPPORTED,
    })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    expect(result.hasProfiles('claude')).toBe(true)
    expect(result.hasProfiles('grok')).toBe(false)
    expect(result.profilesForAgent('codex').map((p) => p.id)).toEqual(['b'])
    scope.stop()
  })

  it('loads duplicate account groups on connect and exposes them via duplicateFor', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', {
      profiles: [profile('p1', 'claude', 'Account 3'), profile('p2', 'claude', 'Account 5')],
      defaults: {},
      supported_agents: SUPPORTED,
      duplicates: {
        claude: {
          p1: { email: 'same@example.com', slotIds: ['p1', 'p2'] },
          p2: { email: 'same@example.com', slotIds: ['p1', 'p2'] },
        },
      },
    })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    expect(result.duplicateFor('claude', 'p1')).toEqual({
      email: 'same@example.com',
      slotIds: ['p1', 'p2'],
    })
    expect(result.duplicateFor('claude', null)).toBeNull()
    expect(result.duplicateFor('codex', 'p1')).toBeNull()
    scope.stop()
  })

  it('syncs the duplicate cache from a cli_profiles.changed broadcast, clears included', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()
    expect(result.duplicateFor('claude', '__default__')).toBeNull()

    mock.emit('cli_profiles.changed', {
      duplicates: {
        claude: { __default__: { email: 'dup@example.com', slotIds: ['__default__', 'p1'] } },
      },
      reason: 'poll',
    })
    expect(result.duplicateFor('claude', null)).toEqual({
      email: 'dup@example.com',
      slotIds: ['__default__', 'p1'],
    })

    // The spare row was deleted: an empty map must clear the warning.
    mock.emit('cli_profiles.changed', { duplicates: {}, reason: 'delete' })
    expect(result.duplicateFor('claude', null)).toBeNull()
    scope.stop()
  })
})

describe('createCliAccountSwitchHandler', () => {
  type SetDefaultFn = (
    agentKey: string,
    profileId: string | null,
    opts?: { force?: boolean; restoreLive?: { liveFingerprint: string } },
  ) => Promise<SetDefaultResult>

  function makeCaps(confirmResult = true) {
    return {
      confirm: vi.fn(async () => confirmResult),
      agentLabel: (agentKey: string) => agentKey,
      startLogin: vi.fn(),
    }
  }

  it('passes a clean switch straight through (no confirm)', async () => {
    const setDefault = vi.fn<SetDefaultFn>().mockResolvedValue({ ok: true })
    const caps = makeCaps()
    const handler = createCliAccountSwitchHandler({ setDefault }, caps)

    const res = await handler('claude', 'p1')
    expect(res).toEqual({ ok: true })
    expect(setDefault).toHaveBeenCalledTimes(1)
    expect(setDefault).toHaveBeenCalledWith('claude', 'p1')
    expect(caps.confirm).not.toHaveBeenCalled()
  })

  it('carries the account prompt\'s restoreLive through the first send and the forced resend', async () => {
    const setDefault = vi.fn<SetDefaultFn>()
      .mockResolvedValueOnce({ ok: false, code: 'PANES_RUNNING', count: 1, message: 'busy' })
      .mockResolvedValueOnce({ ok: true })
    const handler = createCliAccountSwitchHandler({ setDefault }, makeCaps())

    const restoreLive = { liveFingerprint: 'fp-b' }
    expect(await handler('claude', 'p1', { restoreLive })).toEqual({ ok: true })
    expect(setDefault.mock.calls).toEqual([
      ['claude', 'p1', { restoreLive }],
      ['claude', 'p1', { force: true, restoreLive }],
    ])
  })

  it('starts a sign-in when the switched-to account has no usable credentials', async () => {
    const setDefault = vi.fn<SetDefaultFn>().mockResolvedValue({
      ok: true,
      needsLogin: true,
      needsLoginReason: 'signed-out',
    })
    const caps = makeCaps()
    const handler = createCliAccountSwitchHandler({ setDefault }, caps)

    const res = await handler('claude', 'p1')
    expect(res).toEqual({ ok: true, needsLogin: true, needsLoginReason: 'signed-out' })
    expect(caps.startLogin).toHaveBeenCalledWith('claude', 'signed-out')
  })

  it('passes the expired reason through so the toast can tell it apart', async () => {
    const setDefault = vi.fn<SetDefaultFn>().mockResolvedValue({
      ok: true,
      needsLogin: true,
      needsLoginReason: 'expired',
    })
    const caps = makeCaps()
    const handler = createCliAccountSwitchHandler({ setDefault }, caps)

    await handler('claude', 'p1')
    expect(caps.startLogin).toHaveBeenCalledWith('claude', 'expired')
  })

  it('starts a sign-in for a backend that sends no reason at all', async () => {
    const setDefault = vi.fn<SetDefaultFn>().mockResolvedValue({ ok: true, needsLogin: true })
    const caps = makeCaps()
    const handler = createCliAccountSwitchHandler({ setDefault }, caps)

    await handler('claude', 'p1')
    expect(caps.startLogin).toHaveBeenCalledWith('claude', undefined)
  })

  it('starts a sign-in after a FORCED switch onto a signed-out account', async () => {
    const setDefault = vi
      .fn<SetDefaultFn>()
      .mockResolvedValueOnce({ ok: false, code: 'PANES_RUNNING', count: 1, message: 'in use' })
      .mockResolvedValueOnce({ ok: true, needsLogin: true, needsLoginReason: 'signed-out' })
    const caps = makeCaps()
    const handler = createCliAccountSwitchHandler({ setDefault }, caps)

    await handler('claude', 'p1')
    expect(caps.startLogin).toHaveBeenCalledWith('claude', 'signed-out')
  })

  it('leaves a usable account alone (no sign-in)', async () => {
    const setDefault = vi.fn<SetDefaultFn>().mockResolvedValue({ ok: true, needsLogin: false })
    const caps = makeCaps()
    const handler = createCliAccountSwitchHandler({ setDefault }, caps)

    await handler('claude', 'p1')
    expect(caps.startLogin).not.toHaveBeenCalled()
  })

  it('PANES_RUNNING: confirm, then force the switch — no direct restart (broadcast-driven)', async () => {
    const setDefault = vi
      .fn<SetDefaultFn>()
      .mockResolvedValueOnce({ ok: false, code: 'PANES_RUNNING', count: 2, message: 'in use' })
      .mockResolvedValueOnce({ ok: true })
    const caps = makeCaps()
    const handler = createCliAccountSwitchHandler({ setDefault }, caps)

    const res = await handler('claude', 'p1')
    expect(res).toEqual({ ok: true })
    expect(setDefault).toHaveBeenCalledTimes(2)
    expect(setDefault).toHaveBeenNthCalledWith(1, 'claude', 'p1')
    expect(setDefault).toHaveBeenNthCalledWith(2, 'claude', 'p1', { force: true })
    expect(caps.confirm).toHaveBeenCalledTimes(1)
  })

  it('a declined confirm cancels the switch with a message-less failure', async () => {
    const setDefault = vi
      .fn<SetDefaultFn>()
      .mockResolvedValue({ ok: false, code: 'PANES_RUNNING', count: 1, message: 'in use' })
    const caps = makeCaps(false)
    const handler = createCliAccountSwitchHandler({ setDefault }, caps)

    const res = await handler('claude', 'p1')
    expect(res).toEqual({ ok: false, code: 'PANES_RUNNING' })
    expect(setDefault).toHaveBeenCalledTimes(1)
  })

  it('a failing forced switch surfaces the forced failure', async () => {
    const setDefault = vi
      .fn<SetDefaultFn>()
      .mockResolvedValueOnce({ ok: false, code: 'PANES_RUNNING', count: 1, message: 'in use' })
      .mockResolvedValueOnce({ ok: false, code: 'PROFILE_SWAP_FAILED', message: 'swap failed' })
    const caps = makeCaps()
    const handler = createCliAccountSwitchHandler({ setDefault }, caps)

    const res = await handler('claude', 'p1')
    expect(res).toEqual({ ok: false, code: 'PROFILE_SWAP_FAILED', message: 'swap failed' })
  })

  it('non-PANES_RUNNING failures pass through without a confirm', async () => {
    const setDefault = vi
      .fn<SetDefaultFn>()
      .mockResolvedValue({ ok: false, code: 'PROFILE_SWAP_FAILED', message: 'swap failed' })
    const caps = makeCaps()
    const handler = createCliAccountSwitchHandler({ setDefault }, caps)

    const res = await handler('claude', 'p1')
    expect(res).toEqual({ ok: false, code: 'PROFILE_SWAP_FAILED', message: 'swap failed' })
    expect(caps.confirm).not.toHaveBeenCalled()
  })
})

describe('createCliAccountSwitchHandler — unverifiable live drift', () => {
  const DRIFT: SetDefaultResult = { ok: false, code: 'LIVE_DRIFT', message: 'drift', liveDrift: { verified: false, currentSlotId: '__default__', epoch: 4, liveFingerprint: 'fp-1' } }
  function driftApi(sequence: SetDefaultResult[]) {
    const setDefault = vi.fn(async () => sequence.shift() ?? ({ ok: true } as SetDefaultResult))
    return { setDefault }
  }
  const caps = () => ({
    confirm: vi.fn(async () => true),
    agentLabel: (k: string) => k,
    accountLabel: (_k: string, id: string | null) => (id ?? 'Default'),
    startLogin: vi.fn(),
  })

  it('asks the user (naming the account the BACKEND reported current) and resends with that slot + epoch as the expected state', async () => {
    const api = driftApi([DRIFT, { ok: true }])
    const c = caps()
    const res = await createCliAccountSwitchHandler(api, c)('kilo', 'p1')
    expect(res).toEqual({ ok: true })
    expect(c.confirm).toHaveBeenCalledTimes(1)
    const [body, opts] = c.confirm.mock.calls[0] as unknown as [string, { confirmText: string }]
    expect(body).toContain('no identity')
    expect(body).toContain('Default')
    expect(body).toContain('p1')
    expect(opts.confirmText).toContain('Default')
    expect(api.setDefault).toHaveBeenNthCalledWith(1, 'kilo', 'p1')
    expect(api.setDefault).toHaveBeenNthCalledWith(2, 'kilo', 'p1', {
      assumeLiveIsCurrent: { expectedCurrentSlotId: '__default__', expectedEpoch: 4, liveFingerprint: 'fp-1' },
    })
  })

  it('a decline resends nothing and returns the refusal', async () => {
    const api = driftApi([DRIFT])
    const c = caps()
    c.confirm.mockResolvedValueOnce(false)
    const res = await createCliAccountSwitchHandler(api, c)('kilo', 'p1')
    expect(res).toMatchObject({ ok: false, code: 'LIVE_DRIFT' })
    expect(api.setDefault).toHaveBeenCalledTimes(1)
  })

  it('a verified drift is returned as-is: no confirm, no assumption', async () => {
    const api = driftApi([{ ...DRIFT, liveDrift: { verified: true, currentSlotId: '__default__', epoch: 4, liveFingerprint: 'fp-1' } } as SetDefaultResult])
    const c = caps()
    const res = await createCliAccountSwitchHandler(api, c)('kilo', 'p1')
    expect(res).toMatchObject({ ok: false, code: 'LIVE_DRIFT' })
    expect(c.confirm).not.toHaveBeenCalled()
    expect(api.setDefault).toHaveBeenCalledTimes(1)
  })

  it('a refusal missing the current slot, the epoch or the fingerprint gets no assumption: refusal shown, nothing resent', async () => {
    for (const drift of [
      { verified: false, currentSlotId: null, epoch: 4, liveFingerprint: 'fp-1' },
      { verified: false, currentSlotId: '__default__', epoch: null, liveFingerprint: 'fp-1' },
      { verified: false, currentSlotId: '__default__', epoch: 4, liveFingerprint: null },
    ]) {
      const api = driftApi([{ ok: false, code: 'LIVE_DRIFT', message: 'drift', liveDrift: drift } as SetDefaultResult])
      const c = caps()
      const res = await createCliAccountSwitchHandler(api, c)('kilo', 'p1')
      expect(res).toMatchObject({ ok: false, code: 'LIVE_DRIFT' })
      expect(c.confirm).not.toHaveBeenCalled()
      expect(api.setDefault).toHaveBeenCalledTimes(1)
    }
  })

  it('a stale refusal on the resend (the account or its epoch moved while the dialog was open, A→C→A included) is returned, never forced or re-asked', async () => {
    const api = driftApi([DRIFT, { ok: false, code: 'STALE_EPOCH', message: 'epoch moved' }])
    const c = caps()
    const res = await createCliAccountSwitchHandler(api, c)('kilo', 'p1')
    expect(res).toMatchObject({ ok: false, code: 'STALE_EPOCH' })
    expect(api.setDefault).toHaveBeenCalledTimes(2)
    expect(api.setDefault).not.toHaveBeenCalledWith('kilo', 'p1', expect.objectContaining({ force: true }))
    expect(c.confirm).toHaveBeenCalledTimes(1)
  })
})

describe('setDefault — LIVE_DRIFT payload', () => {
  it('carries verified and sends assume_live_is_current only when asked', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: [...SUPPORTED, 'kilo'] })
    mock.setResponse('cli_profiles.set_default', null as unknown as object, {
      ok: false, error: { code: 'LIVE_DRIFT', message: 'LIVE_DRIFT', details: { currentSlotId: '__default__', targetSlotId: 'p1', verified: false, liveIdentity: { email: null, signedIn: true } } },
    })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()
    const res = await result.setDefault('kilo', 'p1')
    expect(res).toMatchObject({ ok: false, code: 'LIVE_DRIFT', liveDrift: { verified: false, currentSlotId: '__default__', epoch: null, liveFingerprint: null } })
    expect(mock.sent.find((s) => s.type === 'cli_profiles.set_default')?.payload).toEqual({ agent_key: 'kilo', profile_id: 'p1' })
    mock.sent.length = 0
    await result.setDefault('kilo', 'p1', { assumeLiveIsCurrent: { expectedCurrentSlotId: '__default__', expectedEpoch: 4, liveFingerprint: 'fp-1' } })
    expect(mock.sent.find((s) => s.type === 'cli_profiles.set_default')?.payload).toEqual({
      agent_key: 'kilo', profile_id: 'p1', assume_live_is_current: true, expected_current_slot_id: '__default__', expected_epoch: 4, live_fingerprint: 'fp-1',
    })
    // The backend's epoch and fingerprint are carried back verbatim when it
    // reports them.
    mock.setResponse('cli_profiles.set_default', null as unknown as object, {
      ok: false, error: { code: 'LIVE_DRIFT', message: 'LIVE_DRIFT', details: { currentSlotId: 'p2', targetSlotId: 'p1', verified: false, epoch: 9, liveFingerprint: 'fp-9' } },
    })
    expect(await result.setDefault('kilo', 'p1')).toMatchObject({ liveDrift: { verified: false, currentSlotId: 'p2', epoch: 9, liveFingerprint: 'fp-9' } })
    scope.stop()
  })
})

describe('forcedRestartAgentKey', () => {
  it('returns the agent key for a forced set_default broadcast', () => {
    expect(
      forcedRestartAgentKey({ reason: 'set_default', forced: true, agent_key: 'claude' }),
    ).toBe('claude')
  })

  it('returns null for a quiet (non-forced) set_default', () => {
    expect(
      forcedRestartAgentKey({ reason: 'set_default', forced: false, agent_key: 'claude' }),
    ).toBeNull()
  })

  it('returns null for other reasons and malformed payloads', () => {
    expect(
      forcedRestartAgentKey({ reason: 'login-harvest', forced: true, agent_key: 'claude' }),
    ).toBeNull()
    expect(forcedRestartAgentKey({ reason: 'set_default', forced: true })).toBeNull()
    expect(forcedRestartAgentKey(undefined)).toBeNull()
    expect(forcedRestartAgentKey(null)).toBeNull()
  })
})

describe('paneNeedsAccountRestart', () => {
  const pane = {
    realized: true,
    agentKey: 'claude',
    isLogin: false,
    pinnedSessionId: 'sess-1',
    sessionOnDisk: true,
  }

  it('includes a realized, live pane of the switched agent', () => {
    expect(paneNeedsAccountRestart(pane, 'claude', 'running')).toBe(true)
  })

  it('includes a pane whose terminal ref has not mounted yet (undefined status)', () => {
    expect(paneNeedsAccountRestart(pane, 'claude', undefined)).toBe(true)
  })

  it('excludes login panes, other agents, and unrealized panes', () => {
    expect(paneNeedsAccountRestart({ ...pane, isLogin: true }, 'claude', 'running')).toBe(false)
    expect(paneNeedsAccountRestart(pane, 'codex', 'running')).toBe(false)
    expect(paneNeedsAccountRestart({ ...pane, realized: false }, 'claude', 'running')).toBe(false)
  })

  it('excludes exited and errored panes', () => {
    expect(paneNeedsAccountRestart(pane, 'claude', 'exited')).toBe(false)
    expect(paneNeedsAccountRestart(pane, 'claude', 'error')).toBe(false)
  })

  // A resume needs a session to resume into. Without one the rebuild fails
  // every time, and counting that failure reports a problem that is not one.
  it('excludes a pane that has no session yet', () => {
    expect(paneNeedsAccountRestart({ ...pane, pinnedSessionId: '' }, 'claude', 'running')).toBe(false)
  })

  it('excludes a pane whose transcript is not on disk yet', () => {
    expect(paneNeedsAccountRestart({ ...pane, sessionOnDisk: false }, 'claude', 'running')).toBe(false)
  })

  it('excludes an agent with no resume support', () => {
    expect(paneNeedsAccountRestart({ ...pane, agentKey: 'aider' }, 'aider', 'running')).toBe(false)
  })
})

describe('runAccountRestartBatch', () => {
  it('all panes restart cleanly: no toast, no log', async () => {
    const log = vi.fn()
    const toastPartial = vi.fn()
    await runAccountRestartBatch(
      ['pane-1', 'pane-2'],
      vi.fn(async () => undefined),
      log,
      toastPartial,
    )
    expect(toastPartial).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it('aggregates returned failure tokens and thrown errors into one toast', async () => {
    const log = vi.fn()
    const toastPartial = vi.fn()
    const rebuild = vi
      .fn<(id: string) => Promise<string | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce('no-session')
      .mockRejectedValueOnce(new Error('boom'))
    await runAccountRestartBatch(['pane-1', 'pane-2', 'pane-3'], rebuild, log, toastPartial)
    expect(toastPartial).toHaveBeenCalledTimes(1)
    expect(toastPartial).toHaveBeenCalledWith(2, 3)
    expect(log).toHaveBeenCalledTimes(2)
    expect(log.mock.calls[0][0]).toContain('no-session')
    expect(log.mock.calls[1][0]).toContain('boom')
  })

  // ── portable credentials ───────────────────────────────────────────────────

  const PORTABLE = {
    'claude/__default__': {
      agentKey: 'claude',
      slotId: '__default__',
      configured: true,
      enabled: true,
      env: 'CLAUDE_CODE_OAUTH_TOKEN',
    },
  }

  it('takes portable metadata and the supported list off the profile list', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', {
      profiles: [],
      defaults: {},
      supported_agents: SUPPORTED,
      portable_credentials: PORTABLE,
      portable_supported: ['claude'],
    })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    expect(result.portableSupportedFor('claude')).toBe(true)
    expect(result.portableSupportedFor('codex')).toBe(false)
    expect(result.portableFor('claude', null)?.env).toBe('CLAUDE_CODE_OAUTH_TOKEN')
    expect(result.portableFor('claude', 'p9')).toBeNull()
    scope.stop()
  })

  it('portableSet sends the secret once, snake_case, and keeps only the metadata', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
    mock.setResponse('cli_profiles.portable_set', { portable: PORTABLE['claude/__default__'] })
    mock.setResponse('sync.status', { scopes: { credentials: false } })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    const out = await result.portableSet('claude', null, 'sk-ant-oat01-SYNTHETIC')
    await flush()
    expect(out).toEqual({ ok: true })
    const call = mock.sent.find((s) => s.type === 'cli_profiles.portable_set')
    expect(call?.payload).toEqual({
      agent_key: 'claude',
      profile_id: '__default__',
      secret: 'sk-ant-oat01-SYNTHETIC',
    })
    expect(result.portableFor('claude', null)?.configured).toBe(true)
    // Nothing the composable holds afterwards contains the value.
    expect(JSON.stringify(result.portable.value)).not.toContain('sk-ant-oat01')
    expect(JSON.stringify(result.cloud.value)).not.toContain('sk-ant-oat01')
    // A save re-reads the cloud state (the backend schedules the push itself).
    expect(mock.sent.some((s) => s.type === 'sync.status')).toBe(true)
    scope.stop()
  })

  it('portableClear names the row and never says anything about the cloud', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', {
      profiles: [profile('p1', 'claude', 'Work')],
      defaults: {},
      supported_agents: SUPPORTED,
      portable_credentials: { 'claude/p1': { ...PORTABLE['claude/__default__'], slotId: 'p1' } },
    })
    mock.setResponse('cli_profiles.portable_clear', {})
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    expect(await result.portableClear('claude', 'p1')).toBe(true)
    const call = mock.sent.find((s) => s.type === 'cli_profiles.portable_clear')
    expect(call?.payload).toEqual({ agent_key: 'claude', profile_id: 'p1' })
    expect(result.portableFor('claude', 'p1')).toBeNull()
    expect(mock.sent.some((s) => s.type.startsWith('sync.push') || s.type === 'sync.pull_items')).toBe(false)
    scope.stop()
  })

  it('the changed broadcast replaces the portable map and re-reads the cloud', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()
    mock.sent.length = 0

    mock.emit('cli_profiles.changed', { portable_credentials: PORTABLE, reason: 'portable-set' })
    await flush()
    expect(result.portableFor('claude', null)?.configured).toBe(true)
    expect(mock.sent.some((s) => s.type === 'sync.status')).toBe(true)
    scope.stop()
  })

  // ── cloud state ────────────────────────────────────────────────────────────

  it('reports the credentials section as off without asking for the inventory', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
    mock.setResponse('sync.status', { scopes: { credentials: false, prompts: true } })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    await result.refreshCloud()
    expect(result.cloudStatus.value).toBe('off')
    expect(mock.sent.some((s) => s.type === 'sync.inventory')).toBe(false)
    scope.stop()
  })

  it('groups the inventory by the slot named in each side\'s metadata', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
    mock.setResponse('sync.status', { scopes: { credentials: true } })
    mock.setResponse('sync.inventory', {
      status: 'connected',
      scopes: {
        credentials: {
          scope: 'credentials',
          status: 'ok',
          items: [
            {
              itemId: 'c-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              state: 'in-sync',
              local: { present: true, fingerprint: 'f1', meta: { agentKey: 'claude', slotId: '__default__' } },
              remote: {
                present: true,
                rev: 3,
                updatedAt: '2026-09-16T05:06:19Z',
                deviceId: 'Studio',
                deleted: false,
                fingerprint: 'f1',
                readable: true,
                meta: { agentKey: 'claude', slotId: '__default__' },
              },
            },
            {
              itemId: 'c-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              state: 'remote-only',
              local: null,
              remote: {
                present: true,
                rev: 4,
                updatedAt: '2026-09-16T06:00:00Z',
                deviceId: 'Laptop',
                deleted: false,
                fingerprint: 'f2',
                readable: true,
                meta: { agentKey: 'claude', slotId: 'p1' },
              },
            },
            {
              // Unreadable on both sides: nothing says which slot it is, so it
              // has no home in the pane.
              itemId: 'c-cccccccccccccccccccccccccccccccc',
              state: 'remote-only',
              local: null,
              remote: { present: true, rev: 5, updatedAt: '', deviceId: 'x', deleted: false, fingerprint: null, readable: false },
            },
          ],
        },
      },
    })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    await result.refreshCloud()
    expect(result.cloudStatus.value).toBe('ok')
    const call = mock.sent.find((s) => s.type === 'sync.inventory')
    expect(call?.payload).toEqual({ scope: 'credentials' })
    expect(result.cloudFor('claude', null)).toEqual([
      {
        itemId: 'c-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        state: 'in-sync',
        localPresent: true,
        remotePresent: true,
        updatedAt: '2026-09-16T05:06:19Z',
        deviceId: 'Studio',
        readable: true,
      },
    ])
    expect(result.cloudFor('claude', 'p1').map((c) => c.state)).toEqual(['remote-only'])
    expect(result.cloudFor('codex', null)).toEqual([])
    scope.stop()
  })

  it('useFromCloud pulls exactly that item and re-reads the cloud', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
    mock.setResponse('sync.status', { scopes: { credentials: true } })
    mock.setResponse('sync.inventory', { scopes: { credentials: { scope: 'credentials', status: 'ok', items: [] } } })
    mock.setResponse('sync.pull_items', {
      scope: 'credentials',
      results: [{ itemId: 'c-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', result: 'pulled', rev: 4 }],
    })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    expect(await result.useFromCloud('c-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')).toEqual({ ok: true })
    const call = mock.sent.find((s) => s.type === 'sync.pull_items')
    expect(call?.payload).toEqual({ scope: 'credentials', itemIds: ['c-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'] })
    expect(mock.sent.filter((s) => s.type === 'sync.inventory')).toHaveLength(1)

    mock.setResponse('sync.pull_items', {
      scope: 'credentials',
      results: [{ itemId: 'c-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', result: 'conflict' }],
    })
    expect(await result.useFromCloud('c-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')).toEqual({ ok: false, message: 'conflict' })
    scope.stop()
  })

  it('importedSlotsFor joins listed imports with cloud-only slots this install has no profile for', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', {
      profiles: [profile('p-local', 'claude', 'Work')],
      defaults: {},
      supported_agents: SUPPORTED,
      portable_credentials: {
        'claude/p-listed': { agentKey: 'claude', slotId: 'p-listed', configured: true, enabled: false, source: 'imported' },
        'claude/__default__': { agentKey: 'claude', slotId: '__default__', configured: true, enabled: true, source: 'local' },
      },
    })
    mock.setResponse('sync.status', { scopes: { credentials: true } })
    const row = (slotId: string, state: string) => ({
      itemId: `c-${slotId.padEnd(32, '0')}`,
      state,
      local: null,
      remote: { present: true, rev: 1, updatedAt: '', deviceId: 'x', deleted: false, fingerprint: 'f', readable: true, meta: { agentKey: 'claude', slotId } },
    })
    mock.setResponse('sync.inventory', {
      scopes: {
        credentials: {
          scope: 'credentials',
          status: 'ok',
          items: [row('p-listed', 'in-sync'), row('p-removed', 'remote-only'), row('p-local', 'remote-only'), row('__default__', 'in-sync')],
        },
      },
    })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()
    await result.refreshCloud()

    const slots = result.importedSlotsFor('claude').map((m) => [m.slotId, m.source ?? 'none'])
    // p-listed: the listed import; p-removed: cloud-only placeholder; p-local
    // and __default__ have cards of their own and are left out.
    expect(slots).toEqual([
      ['p-listed', 'imported'],
      ['p-removed', 'none'],
    ])
    scope.stop()
  })
})

describe('useCliProfiles – claude accounts with their own config dir', () => {
  it('loads account dirs and pane defaults, and follows the broadcast', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', {
      profiles: [profile('p1', 'claude', 'A'), profile('p2', 'claude', 'B')],
      defaults: { claude: 'p1' },
      supported_agents: SUPPORTED,
      accountDirs: { claude: { p2: { signedIn: true, email: 'b@x.com' } } },
      paneDefaults: { claude: 'p2' },
    })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    expect(result.accountDirFor('claude', 'p2')).toEqual({ signedIn: true, email: 'b@x.com' })
    expect(result.accountDirFor('claude', 'p1')).toBe(null)
    expect(result.accountDirFor('claude', '__default__')).toBe(null)
    expect(result.newPaneProfileId('claude')).toBe('p2')

    // Clearing the last choice broadcasts {} — it must not be ignored.
    mock.emit('cli_profiles.changed', { paneDefaults: {}, accountDirs: {}, reason: 'set_pane_default' })
    expect(result.newPaneProfileId('claude')).toBe('p1')
    expect(result.accountDirFor('claude', 'p2')).toBe(null)
    scope.stop()
  })

  it('setPaneDefault sends the choice and adopts the returned map', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
    mock.setResponse('cli_profiles.set_pane_default', { paneDefaults: { claude: 'p2' } })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    const res = await result.setPaneDefault('claude', 'p2')
    expect(res).toEqual({ ok: true })
    const call = mock.sent.find((s) => s.type === 'cli_profiles.set_pane_default')
    expect(call?.payload).toEqual({ agent_key: 'claude', profile_id: 'p2' })
    expect(result.newPaneProfileId('claude')).toBe('p2')
    scope.stop()
  })
})

describe('useCliProfiles – deleting an account its own-dir panes still use', () => {
  it('explains ACCOUNT_DIR_IN_USE in the UI language, with the pane count', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
    mock.setResponse('cli_profiles.delete', null as unknown as object, {
      ok: false,
      error: {
        code: 'ACCOUNT_DIR_IN_USE',
        message: "2 running claude pane(s) use this account's own config dir; close them before deleting it",
        details: { count: 2, agent_key: 'claude' },
      },
    })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    expect(await result.remove('p1')).toBe(false)
    expect(result.error.value).toBe(
      i18n.global.t('settings.accounts.cli.account-dir-in-use-error', { count: 2 }),
    )
    expect(result.error.value).not.toContain('config dir')
    scope.stop()
  })
})

describe('useCliProfiles – a pane reports its account dir login expired', () => {
  it('sends the profile to the backend and reports whether it was marked', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
    mock.setResponse('cli_profiles.account_dir_expired', { ok: true, marked: true })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()

    expect(await result.reportAccountDirExpired('p2')).toBe(true)
    const call = mock.sent.find((s) => s.type === 'cli_profiles.account_dir_expired')
    expect(call?.payload).toEqual({ profile_id: 'p2' })
    scope.stop()
  })
})
