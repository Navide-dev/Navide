// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { CLI_AGENT_SPECS } from '@navide/plugin-shell'
import CliAccountsPane from '../CliAccountsPane.vue'
import { i18n } from '@navide/plugin-ui/foundation'
import {
  cliAccountDirActionsKey,
  cliAccountSwitchKey,
  createCliAccountSwitchHandler,
  type CliAccountDirActions,
  type CliProfileAccountDirs,
  type useCliProfiles,
  type CliAccountSwitchHandler,
  type CliProfile,
  type CliProfileDefaults,
  type CliProfileDuplicates,
  type CliProfileIdentities,
  type CliPortableCredentials,
  type CliCloudCredentials,
  type CloudCredentialStatus,
} from '../../composables/useCliProfiles'
import { usageVersion, type UsageSnapshot } from '../../composables/useUsage'

// Partial-mock useUsage: stub the store reader (usageFor) and the backend
// call (refreshUsage), keep the pure formatters (same pattern as
// UsageBadge.test.ts).
const usage = vi.hoisted(() => ({
  usageFor: vi.fn<(agentKey: string | undefined | null) => UsageSnapshot | undefined>(),
  accountUsageFor: vi.fn<
    (agentKey: string | undefined | null, profileId: string | null) => UsageSnapshot | undefined
  >(),
  refreshUsage: vi.fn<(agentKey?: string, slotId?: string | null) => boolean>(() => true),
  usageBackendConnected: vi.fn<() => boolean>(() => true),
}))
vi.mock('../../composables/useUsage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../composables/useUsage')>()
  return {
    ...actual,
    usageFor: usage.usageFor,
    accountUsageFor: usage.accountUsageFor,
    refreshUsage: usage.refreshUsage,
    usageBackendConnected: usage.usageBackendConnected,
  }
})

// Stub useNotify (module-level singleton) so confirm dialogs resolve without
// rendering NotificationHost. Shared spies, reset between tests.
const notify = {
  toast: vi.fn(),
  alert: vi.fn(async () => true),
  confirm: vi.fn(async (..._args: unknown[]) => true),
  prompt: vi.fn(async () => null),
}
vi.mock('@navide/plugin-ui/foundation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/plugin-ui/foundation')>()),
  useNotify: () => notify,
}))

// CLI_AGENT_SPECS order: claude(0), codex(1), antigravity(2), grok(3), kimi(4)
const SUPPORTED = ['claude', 'codex', 'grok', 'kimi']

interface ApiOptions {
  profiles?: CliProfile[]
  defaults?: CliProfileDefaults
  identities?: CliProfileIdentities
  /** agentKey -> the user's alias for that agent's built-in Default slot. */
  defaultNames?: Record<string, string>
  duplicates?: CliProfileDuplicates
  supported?: string[]
  error?: string
  portable?: CliPortableCredentials
  portableSupported?: string[]
  cloud?: CliCloudCredentials
  cloudStatus?: CloudCredentialStatus
  /** Provider scopes per agent (the backend capability's `scopes`). */
  scopes?: Record<string, string[]>
  /** Agents whose capability says loginIsolation === 'global'. */
  globalLogin?: string[]
  /** Claude accounts signed in inside their own config dir. */
  accountDirs?: CliProfileAccountDirs
}

// Fake `api` prop mirroring the useCliProfiles return shape (refs + fns),
// with no backend WS underneath.
function makeApi(opts: ApiOptions = {}) {
  const profiles = ref<CliProfile[]>(opts.profiles ?? [])
  const defaults = ref<CliProfileDefaults>(opts.defaults ?? {})
  const identities = ref<CliProfileIdentities>(opts.identities ?? {})
  const defaultNames = ref<Record<string, string>>(opts.defaultNames ?? {})
  const duplicates = ref<CliProfileDuplicates>(opts.duplicates ?? {})
  const supportedAgents = ref<string[]>(opts.supported ?? SUPPORTED)
  const error = ref<string>(opts.error ?? '')
  const portable = ref<CliPortableCredentials>(opts.portable ?? {})
  const portableSupported = ref<string[]>(opts.portableSupported ?? [])
  const cloud = ref<CliCloudCredentials>(opts.cloud ?? {})
  const cloudStatus = ref<CloudCredentialStatus>(opts.cloudStatus ?? 'off')

  const api = {
    profiles,
    defaults,
    identities,
    defaultNames,
    duplicates,
    supportedAgents,
    loaded: ref(true),
    loading: ref(false),
    error,
    refresh: vi.fn(async () => {}),
    create: vi.fn(async (agentKey: string, name: string, scope?: string | null): Promise<CliProfile | null> => {
      const profile: CliProfile = { id: 'created-id', agentKey, name, createdAt: '2026-07-25', scope: scope ?? null }
      profiles.value = [...profiles.value, profile]
      return profile
    }),
    scopesFor: (agentKey: string) => opts.scopes?.[agentKey] ?? [],
    capabilityFor: () => undefined,
    loginIsGlobal: (agentKey: string) => opts.globalLogin?.includes(agentKey) ?? false,
    rename: vi.fn(async () => null),
    remove: vi.fn(async () => true),
    setDefault: vi.fn(async () => ({ ok: true as const })),
    profilesForAgent: (agentKey: string) => profiles.value.filter((p) => p.agentKey === agentKey),
    hasProfiles: (agentKey: string) => profiles.value.some((p) => p.agentKey === agentKey),
    defaultProfileId: (agentKey: string) => defaults.value[agentKey] ?? null,
    findProfile: (id: string | null | undefined) =>
      id ? profiles.value.find((p) => p.id === id) : undefined,
    identityFor: (agentKey: string, profileId: string | null) =>
      identities.value[agentKey]?.[profileId ?? '__default__'] ?? null,
    aliasFor: (agentKey: string, profileId: string | null | undefined) => {
      if (profileId && profileId !== '__default__') {
        const profile = profiles.value.find((p) => p.id === profileId)
        return profile?.nameIsCustom ? profile.name : undefined
      }
      return defaultNames.value[agentKey] || undefined
    },
    accountDirFor: (agentKey: string, profileId: string | null | undefined) =>
      profileId && profileId !== '__default__' ? (opts.accountDirs?.[agentKey]?.[profileId] ?? null) : null,
    duplicateFor: (agentKey: string, profileId: string | null) =>
      duplicates.value[agentKey]?.[profileId ?? '__default__'] ?? null,
    portable,
    portableSupported,
    portableSupportedFor: (agentKey: string) => portableSupported.value.includes(agentKey),
    portableFor: (agentKey: string, profileId: string | null) =>
      portable.value[`${agentKey}/${profileId ?? '__default__'}`] ?? null,
    portableSet: vi.fn(async (agentKey: string, profileId: string | null) => {
      portable.value = {
        ...portable.value,
        [`${agentKey}/${profileId ?? '__default__'}`]: {
          agentKey,
          slotId: profileId ?? '__default__',
          configured: true,
          enabled: true,
          env: 'CLAUDE_CODE_OAUTH_TOKEN',
        },
      }
      return { ok: true as const }
    }),
    portableClear: vi.fn(async () => true),
    portableDescribe: vi.fn(async (agentKey: string, profileId: string | null) => {
      const meta = {
        agentKey,
        slotId: profileId ?? '__default__',
        configured: false,
        enabled: false,
        env: 'CLAUDE_CODE_OAUTH_TOKEN',
        obtainCommand: 'claude setup-token',
        docsUrl: 'https://example.invalid/docs',
      }
      portable.value = { ...portable.value, [`${agentKey}/${profileId ?? '__default__'}`]: meta }
      return meta
    }),
    portableEnable: vi.fn(async (agentKey: string, slotId: string, enabled: boolean) => {
      const key = `${agentKey}/${slotId}`
      const current = portable.value[key]
      if (current) portable.value = { ...portable.value, [key]: { ...current, enabled } }
      return { ok: true as const }
    }),
    importedSlotsFor: (agentKey: string) => {
      const foreign = (slotId: string) =>
        slotId !== '__default__' && !profiles.value.some((p) => p.id === slotId)
      const out = new Map<string, CliPortableCredentials[string]>()
      for (const m of Object.values(portable.value)) {
        if (m.agentKey === agentKey && m.source === 'imported' && foreign(m.slotId)) out.set(m.slotId, m)
      }
      for (const slotId of Object.keys(cloud.value[agentKey] ?? {})) {
        if (foreign(slotId) && !out.has(slotId)) {
          out.set(slotId, { agentKey, slotId, configured: false, enabled: false, source: 'none' })
        }
      }
      return [...out.values()]
    },
    cloud,
    cloudStatus,
    cloudError: ref(''),
    cloudFor: (agentKey: string, profileId: string | null) =>
      cloud.value[agentKey]?.[profileId ?? '__default__'] ?? [],
    refreshCloud: vi.fn(async () => {}),
    useFromCloud: vi.fn(async () => ({ ok: true as const })),
  }
  return api as unknown as ReturnType<typeof useCliProfiles>
}

function profile(id: string, agentKey: string, name: string): CliProfile {
  return { id, agentKey, name, createdAt: '2026-07-25' }
}

describe('CliAccountsPane', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.clearAllMocks()
    usage.usageFor.mockReset()
    usage.accountUsageFor.mockReset()
    usage.refreshUsage.mockReturnValue(true) // default: a connected backend
    usage.usageBackendConnected.mockReturnValue(true)
    localStorage.clear()
  })

  function mountPane(
    api: ReturnType<typeof useCliProfiles>,
    opts: {
      workspaceOpen?: boolean
      switchHandler?: CliAccountSwitchHandler
      dirActions?: CliAccountDirActions
    } = {},
  ) {
    wrapper = mount(CliAccountsPane, {
      props: { api, workspaceOpen: opts.workspaceOpen ?? true },
      global: {
        plugins: [i18n],
        // Mimic the main window providing the quiescence-aware switch handler.
        provide: {
          ...(opts.switchHandler ? { [cliAccountSwitchKey as symbol]: opts.switchHandler } : {}),
          ...(opts.dirActions ? { [cliAccountDirActionsKey as symbol]: opts.dirActions } : {}),
        },
      },
    })
    return wrapper
  }

  /** Section for one agent, by its CLI_AGENT_SPECS index (unsupported agents have none). */
  function section(w: VueWrapper, index: number) {
    const label = CLI_AGENT_SPECS[index].label
    return w.findAll('section.cli-agent').find((s) => s.find('.cli-agent-name').exists() && s.get('.cli-agent-name').text() === label)!
  }

  function buttonByText(scope: ReturnType<VueWrapper['findAll']>[number], text: string) {
    return scope.findAll('button').find((b) => b.text() === text)
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  it('renders the Default row plus profile rows for a supported agent', () => {
    const api = makeApi({
      profiles: [profile('p1', 'claude', 'Account 2'), profile('p2', 'claude', 'Account 3')],
    })
    const w = mountPane(api)

    const claude = section(w, 0)
    expect(claude.text()).toContain('Claude Code')
    expect(claude.findAll('.cli-card')).toHaveLength(3) // Default + 2 profiles
    expect(buttonByText(claude, '+ New Account')).toBeDefined()
    expect(claude.find('.cli-unsupported').exists()).toBe(false)
  })

  it('lists unsupported agents once, with no rows or add button', () => {
    const w = mountPane(makeApi())

    const group = w.find('section.cli-unsupported-group')
    expect(group.get('.cli-unsupported').text()).toBe(
      "Navide can't keep more than one account for these CLIs:",
    )
    expect(group.find('[data-agent="antigravity"]').exists()).toBe(true)
    expect(group.find('[data-agent="claude"]').exists()).toBe(false)
    expect(group.findAll('.cli-card')).toHaveLength(0)
    expect(buttonByText(group, '+ New Account')).toBeUndefined()
  })

  // ── rowName ────────────────────────────────────────────────────────────────

  it('names rows by email first, then profile name when signed in, else not-signed-in', () => {
    const api = makeApi({
      profiles: [
        profile('p-email', 'claude', 'Account 2'),
        profile('p-noemail', 'claude', 'Account 3'),
        profile('p-signedout', 'claude', 'Account 4'),
      ],
      identities: {
        claude: {
          'p-email': { email: 'me@example.com', signedIn: true },
          'p-noemail': { email: null, signedIn: true },
          'p-signedout': { email: null, signedIn: false },
        },
      },
    })
    const w = mountPane(api)

    const names = section(w, 0)
      .findAll('.cli-card-id')
      .map((n) => n.text())
    // Row 0 is the built-in Default (no identity -> "Default" label).
    expect(names).toEqual(['Default', 'me@example.com', 'Account 3', 'Not signed in'])
  })

  // ── renaming a card ────────────────────────────────────────────────────────

  it('leads with the name the user gave an account and keeps the identity below it', () => {
    const api = makeApi({
      profiles: [{ ...profile('p1', 'claude', 'Work'), nameIsCustom: true }],
      identities: { claude: { p1: { email: 'me@example.com', signedIn: true } } },
      defaultNames: { claude: 'Main' },
    })
    const w = mountPane(api)

    const cards = section(w, 0).findAll('.cli-card')
    expect(cards[0].get('.cli-card-id').text()).toBe('Main')
    expect(cards[1].get('.cli-card-id').text()).toBe('Work')
    // The email is how the account is recognised elsewhere; it moves down,
    // it does not disappear.
    expect(cards[1].get('.cli-card-meta').text()).toBe('me@example.com')
  })

  it('renames a profile card from the pencil, agent key included', async () => {
    const api = makeApi({ profiles: [profile('p1', 'claude', 'Account 2')] })
    const w = mountPane(api)

    const card = section(w, 0).findAll('.cli-card')[1]
    await card.get('.cli-card-rename-btn').trigger('click')
    const input = w.get('input.cli-card-rename')
    await input.setValue('Work')
    await input.trigger('keydown.enter')
    await flushPromises()

    expect(api.rename).toHaveBeenCalledWith('p1', 'Work', 'claude')
  })

  it('caps the rename field at 64 characters', async () => {
    const api = makeApi({ profiles: [profile('p1', 'claude', 'Account 2')] })
    const w = mountPane(api)
    await section(w, 0).findAll('.cli-card')[1].get('.cli-card-rename-btn').trigger('click')
    expect(w.get('input.cli-card-rename').attributes('maxlength')).toBe('64')
  })

  it('renames the built-in Default card too — for a vendor with no email it is the only way to tell it apart', async () => {
    const api = makeApi()
    const w = mountPane(api)

    const card = section(w, 0).findAll('.cli-card')[0]
    await card.get('.cli-card-rename-btn').trigger('click')
    const input = w.get('input.cli-card-rename')
    await input.setValue('Main')
    await input.trigger('keydown.enter')
    await flushPromises()

    expect(api.rename).toHaveBeenCalledWith('__default__', 'Main', 'claude')
  })

  it('an emptied field clears the alias rather than storing a blank name', async () => {
    const api = makeApi({
      profiles: [{ ...profile('p1', 'claude', 'Work'), nameIsCustom: true }],
    })
    const w = mountPane(api)

    const card = section(w, 0).findAll('.cli-card')[1]
    await card.get('.cli-card-rename-btn').trigger('click')
    const input = w.get('input.cli-card-rename')
    expect((input.element as HTMLInputElement).value).toBe('Work')
    await input.setValue('   ')
    await input.trigger('keydown.enter')
    await flushPromises()

    expect(api.rename).toHaveBeenCalledWith('p1', '', 'claude')
  })

  it('a cleared alias leaves the card on the identity the backend regenerates', async () => {
    const api = makeApi({
      profiles: [{ ...profile('p1', 'claude', 'Work'), nameIsCustom: true }],
      identities: { claude: { p1: { email: 'me@example.com', signedIn: true } } },
    })
    // What the backend does with an empty name: the custom flag goes and the
    // generated "Account N" comes back.
    ;(api.rename as ReturnType<typeof vi.fn>).mockImplementation(async (id: string, name: string) => {
      api.profiles.value = api.profiles.value.map((p) =>
        p.id === id
          ? name
            ? { ...p, name, nameIsCustom: true }
            : { id, agentKey: p.agentKey, name: 'Account 2', createdAt: p.createdAt }
          : p,
      )
      return null
    })
    const w = mountPane(api)
    expect(section(w, 0).findAll('.cli-card')[1].get('.cli-card-id').text()).toBe('Work')

    const card = section(w, 0).findAll('.cli-card')[1]
    await card.get('.cli-card-rename-btn').trigger('click')
    const input = w.get('input.cli-card-rename')
    await input.setValue('')
    await input.trigger('keydown.enter')
    await flushPromises()

    const after = section(w, 0).findAll('.cli-card')[1]
    expect(after.get('.cli-card-id').text()).toBe('me@example.com')
    // With no alias on top there is no second line repeating the identity.
    expect(after.find('.cli-card-meta').exists()).toBe(false)
  })

  it('Esc leaves the name alone, blur included', async () => {
    const api = makeApi({ profiles: [profile('p1', 'claude', 'Account 2')] })
    const w = mountPane(api)

    const card = section(w, 0).findAll('.cli-card')[1]
    await card.get('.cli-card-rename-btn').trigger('click')
    const input = w.get('input.cli-card-rename')
    await input.setValue('Work')
    await input.trigger('keydown.esc')
    await input.trigger('blur')
    await flushPromises()

    expect(api.rename).not.toHaveBeenCalled()
    expect(w.find('input.cli-card-rename').exists()).toBe(false)
  })

  // ── duplicate accounts ─────────────────────────────────────────────────────

  it('warns on every card of a duplicate group, naming this row and the others', () => {
    const api = makeApi({
      profiles: [profile('p1', 'claude', 'Account 3'), profile('p2', 'claude', 'Account 5')],
      identities: {
        claude: {
          p1: { email: 'same@example.com', signedIn: true },
          p2: { email: 'same@example.com', signedIn: true },
        },
      },
      duplicates: {
        claude: {
          p1: { email: 'same@example.com', slotIds: ['p1', 'p2'] },
          p2: { email: 'same@example.com', slotIds: ['p1', 'p2'] },
        },
      },
    })
    const w = mountPane(api)

    const cards = section(w, 0).findAll('.cli-card')
    // The built-in Default is not in the group.
    expect(cards[0].find('.cli-card-dup').exists()).toBe(false)
    const first = cards[1].get('.cli-card-dup').text()
    expect(first).toContain('Duplicate')
    // Both cards display the same email, so the warning names the rows.
    expect(first).toContain('"Account 3" and Account 5')
    expect(first).toContain('same@example.com')
    expect(cards[2].get('.cli-card-dup').text()).toContain('"Account 5" and Account 3')
    // Deleting stays the user's call — the existing Delete button, nothing new.
    expect(buttonByText(cards[1], 'Delete')).toBeDefined()
  })

  it('shows no duplicate warning when every card holds its own account', () => {
    const api = makeApi({
      profiles: [profile('p1', 'claude', 'Account 3'), profile('p2', 'claude', 'Account 5')],
      identities: {
        claude: {
          p1: { email: 'one@example.com', signedIn: true },
          p2: { email: 'two@example.com', signedIn: true },
        },
      },
    })
    const w = mountPane(api)

    expect(section(w, 0).findAll('.cli-card-dup')).toHaveLength(0)
  })

  // ── addAccount ─────────────────────────────────────────────────────────────

  it('addAccount creates an auto-named slot and emits an isolated login (no switch)', async () => {
    const api = makeApi({ profiles: [profile('p1', 'claude', 'Account 2')] })
    const w = mountPane(api)

    await buttonByText(section(w, 0), '+ New Account')!.trigger('click')
    await flushPromises()

    // 1 existing claude profile -> "Account 3". No scope: claude's store is
    // one credential, so none is sent.
    expect(api.create).toHaveBeenCalledWith('claude', 'Account 3', null)
    expect(api.setDefault).not.toHaveBeenCalled()
    expect(w.emitted('login')).toEqual([['claude', 'created-id']])
  })

  it('a global-login vendor asks before a new account is created, and a decline leaves no row', async () => {
    const api = makeApi({ globalLogin: ['kimi'] })
    const w = mountPane(api)
    const kimi = section(w, 4)

    notify.confirm.mockResolvedValueOnce(false)
    await buttonByText(kimi, '+ New Account')!.trigger('click')
    await flushPromises()
    expect(notify.confirm).toHaveBeenCalledTimes(1)
    const [body, opts] = notify.confirm.mock.calls[0] as [string, { title?: string }]
    // The warning says what moves and what comes back, and names the CLI.
    expect(body).toContain('Kimi Code')
    expect(body).toContain('temporarily replaced')
    expect(body).toContain('restored')
    expect(opts.title).toBeTruthy()
    expect(body).not.toContain('settings.accounts.')
    expect(api.create).not.toHaveBeenCalled()
    expect(w.emitted('login')).toBeUndefined()

    notify.confirm.mockResolvedValueOnce(true)
    await buttonByText(kimi, '+ New Account')!.trigger('click')
    await flushPromises()
    expect(api.create).toHaveBeenCalledWith('kimi', 'Account 2', null)
    expect(w.emitted('login')).toEqual([['kimi', 'created-id']])
  })

  it('an isolated-login vendor asks nothing (unchanged flow)', async () => {
    const api = makeApi({ globalLogin: ['kimi'] })
    const w = mountPane(api)
    await buttonByText(section(w, 0), '+ New Account')!.trigger('click')
    await flushPromises()
    expect(notify.confirm).not.toHaveBeenCalled()
    expect(api.create).toHaveBeenCalledWith('claude', 'Account 2', null)
  })

  it('a multi-provider vendor gets a provider picker whose choice goes to create; none is guessed', async () => {
    const api = makeApi({ supported: [...SUPPORTED, 'opencode'], scopes: { opencode: ['anthropic', 'openai'] } })
    const w = mountPane(api)
    const sec = w.findAll('section.cli-agent').find((s) => s.text().includes('OpenCode'))!
    // Only the multi-provider vendor shows the picker.
    expect(w.findAll('[data-scope-for]').map((el) => el.attributes('data-scope-for'))).toEqual(['opencode'])
    const select = sec.get('[data-scope-for="opencode"]')
    expect(select.findAll('option').map((o) => o.attributes('value'))).toEqual(['anthropic', 'openai'])

    // Default pick is the first declared scope.
    await buttonByText(sec, '+ New Account')!.trigger('click')
    await flushPromises()
    expect(api.create).toHaveBeenLastCalledWith('opencode', 'Account 2', 'anthropic')

    await select.setValue('openai')
    await buttonByText(sec, '+ New Account')!.trigger('click')
    await flushPromises()
    expect(api.create).toHaveBeenLastCalledWith('opencode', 'Account 3', 'openai')
  })

  it('addAccount never reuses a deleted auto name (max existing N + 1)', async () => {
    // "Account 2" was deleted, leaving only "Account 3". Length-based
    // numbering would mint a second "Account 3" — indistinguishable rows for
    // identity-less agents (kimi). Max+1 must yield "Account 4".
    const api = makeApi({ profiles: [profile('p3', 'kimi', 'Account 3')] })
    const w = mountPane(api)

    await buttonByText(section(w, 4), '+ New Account')!.trigger('click')
    await flushPromises()

    expect(api.create).toHaveBeenCalledWith('kimi', 'Account 4', null)
  })

  it('addAccount starts at "Account 2" when no existing name matches the pattern', async () => {
    const api = makeApi({ profiles: [profile('px', 'kimi', 'Work login')] })
    const w = mountPane(api)

    await buttonByText(section(w, 4), '+ New Account')!.trigger('click')
    await flushPromises()

    expect(api.create).toHaveBeenCalledWith('kimi', 'Account 2', null)
  })

  // ── no-workspace guard (login pane needs a workspace to spawn into) ────────

  it('addAccount without a workspace blocks BEFORE creating a row and toasts', async () => {
    const api = makeApi()
    const w = mountPane(api, { workspaceOpen: false })

    await buttonByText(section(w, 0), '+ New Account')!.trigger('click')
    await flushPromises()

    // No orphan "Not signed in" row: create was never called, nothing emitted.
    expect(api.create).not.toHaveBeenCalled()
    expect(w.emitted('login')).toBeUndefined()
    expect(notify.toast).toHaveBeenCalledTimes(1)
    expect(notify.toast.mock.calls[0][0]).toContain('Open a workspace first')
  })

  it('signIn without a workspace blocks up front (no switch, no login emit)', async () => {
    const api = makeApi({ profiles: [profile('p1', 'claude', 'Account 2')] })
    const w = mountPane(api, { workspaceOpen: false })

    const row = section(w, 0).findAll('.cli-card')[1]
    await row.findAll('button').find((b) => b.text() === 'Sign In')!.trigger('click')
    await flushPromises()

    expect(api.setDefault).not.toHaveBeenCalled()
    expect(w.emitted('login')).toBeUndefined()
    expect(notify.toast).toHaveBeenCalledTimes(1)
  })

  // ── signIn ─────────────────────────────────────────────────────────────────

  it('signIn on a non-active profile emits an isolated login without switching', async () => {
    const api = makeApi({ profiles: [profile('p1', 'claude', 'Account 2')] })
    const w = mountPane(api)

    // Row 0 is the built-in Default; row 1 is p1 (not signed in, not active).
    const row = section(w, 0).findAll('.cli-card')[1]
    await row.findAll('button').find((b) => b.text() === 'Sign In')!.trigger('click')
    await flushPromises()

    expect(api.setDefault).not.toHaveBeenCalled()
    expect(w.emitted('login')).toEqual([['claude', 'p1']])
  })

  it('signIn on the ACTIVE profile stays a live login (no profile id)', async () => {
    const api = makeApi({
      profiles: [profile('p1', 'claude', 'Account 2')],
      defaults: { claude: 'p1' },
    })
    const w = mountPane(api)

    const row = section(w, 0).findAll('.cli-card')[1]
    await row.findAll('button').find((b) => b.text() === 'Sign In')!.trigger('click')
    await flushPromises()

    expect(api.setDefault).not.toHaveBeenCalled()
    expect(w.emitted('login')).toEqual([['claude']])
  })

  it('signIn on a non-active Default row still switches first, then logs in live', async () => {
    const api = makeApi({
      profiles: [profile('p1', 'claude', 'Account 2')],
      defaults: { claude: 'p1' },
    })
    const w = mountPane(api)

    const defaultRow = section(w, 0).findAll('.cli-card')[0]
    await defaultRow.findAll('button').find((b) => b.text() === 'Sign In')!.trigger('click')
    await flushPromises()

    expect(api.setDefault).toHaveBeenCalledWith('claude', null)
    expect(w.emitted('login')).toEqual([['claude']])
  })

  it('sets a profile as default via the Set as default button', async () => {
    const api = makeApi({ profiles: [profile('p1', 'claude', 'Account 2')] })
    const setDefault = api.setDefault as ReturnType<typeof vi.fn>
    const w = mountPane(api)

    // Default is null, so the profile row shows "Set as Default".
    await buttonByText(section(w, 0), 'Set as Default')!.trigger('click')
    await flushPromises()

    expect(setDefault).toHaveBeenCalledTimes(1)
    expect(setDefault).toHaveBeenCalledWith('claude', 'p1')
  })

  it('shows the row busy and drops competing clicks until the switch settles', async () => {
    const api = makeApi({ profiles: [profile('p1', 'claude', 'Account 2')] })
    let release: (res: { ok: boolean }) => void = () => {}
    const setDefault = api.setDefault as ReturnType<typeof vi.fn>
    setDefault.mockImplementation(
      () => new Promise<{ ok: boolean }>((resolve) => { release = resolve }),
    )
    const w = mountPane(api)

    await buttonByText(section(w, 0), 'Set as Default')!.trigger('click')
    await flushPromises()

    const busy = buttonByText(section(w, 0), 'Switching…')
    expect(busy).toBeDefined()
    expect(busy!.attributes('disabled')).toBeDefined()
    expect(buttonByText(section(w, 0), 'Set as Default')).toBeUndefined()

    release({ ok: true })
    await flushPromises()
    expect(setDefault).toHaveBeenCalledTimes(1)
    expect(buttonByText(section(w, 0), 'Switching…')).toBeUndefined()
  })

  // ── quiescence switch handler (main window) ────────────────────────────────

  it('routes Set as default through the provided switch handler', async () => {
    const api = makeApi({ profiles: [profile('p1', 'claude', 'Account 2')] })
    const handler = vi.fn(async () => ({ ok: true as const }))
    const w = mountPane(api, { switchHandler: handler })

    await buttonByText(section(w, 0), 'Set as Default')!.trigger('click')
    await flushPromises()

    expect(handler).toHaveBeenCalledWith('claude', 'p1')
    expect(api.setDefault).not.toHaveBeenCalled()
    expect(usage.refreshUsage).toHaveBeenCalledTimes(2) // mount + successful switch
  })

  it('blocked switch: confirm accepted → forced setDefault → usage refreshed', async () => {
    const api = makeApi({ profiles: [profile('p1', 'claude', 'Account 2')] })
    const setDefault = api.setDefault as ReturnType<typeof vi.fn>
    setDefault
      .mockResolvedValueOnce({ ok: false, code: 'PANES_RUNNING', count: 2, message: 'in use' })
      .mockResolvedValueOnce({ ok: true })
    notify.confirm.mockResolvedValueOnce(true)
    const handler = createCliAccountSwitchHandler(api, {
      confirm: (message, opts) => notify.confirm(message, opts) as Promise<boolean>,
      agentLabel: () => 'Claude Code',
      startLogin: () => {},
    })
    const w = mountPane(api, { switchHandler: handler })

    await buttonByText(section(w, 0), 'Set as Default')!.trigger('click')
    await flushPromises()

    expect(notify.confirm).toHaveBeenCalledTimes(1)
    expect(setDefault).toHaveBeenNthCalledWith(1, 'claude', 'p1')
    expect(setDefault).toHaveBeenNthCalledWith(2, 'claude', 'p1', { force: true })
    expect(usage.refreshUsage).toHaveBeenCalledTimes(2) // mount + successful switch
    expect(notify.toast).not.toHaveBeenCalled()
  })

  it('blocked switch: declined confirm switches nothing and stays silent', async () => {
    const api = makeApi({ profiles: [profile('p1', 'claude', 'Account 2')] })
    const setDefault = api.setDefault as ReturnType<typeof vi.fn>
    setDefault.mockResolvedValue({ ok: false, code: 'PANES_RUNNING', count: 2, message: 'in use' })
    notify.confirm.mockResolvedValueOnce(false)
    const handler = createCliAccountSwitchHandler(api, {
      confirm: (message, opts) => notify.confirm(message, opts) as Promise<boolean>,
      agentLabel: () => 'Claude Code',
      startLogin: () => {},
    })
    const w = mountPane(api, { switchHandler: handler })

    await buttonByText(section(w, 0), 'Set as Default')!.trigger('click')
    await flushPromises()

    expect(setDefault).toHaveBeenCalledTimes(1)
    expect(notify.toast).not.toHaveBeenCalled()
    expect(usage.refreshUsage).toHaveBeenCalledTimes(1) // mount only
  })

  it('without a handler, a PANES_RUNNING failure toasts its message (no force)', async () => {
    const api = makeApi({ profiles: [profile('p1', 'claude', 'Account 2')] })
    const setDefault = api.setDefault as ReturnType<typeof vi.fn>
    setDefault.mockResolvedValue({ ok: false, code: 'PANES_RUNNING', count: 1, message: 'panes running' })
    const w = mountPane(api)

    await buttonByText(section(w, 0), 'Set as Default')!.trigger('click')
    await flushPromises()

    expect(setDefault).toHaveBeenCalledTimes(1)
    expect(setDefault).toHaveBeenCalledWith('claude', 'p1')
    expect(notify.toast).toHaveBeenCalledTimes(1)
    expect(notify.toast.mock.calls[0][0]).toBe('panes running')
    expect(usage.refreshUsage).toHaveBeenCalledTimes(1) // mount only
  })

  it('a generic swap failure (e.g. PROFILE_SWAP_FAILED) also toasts its message', async () => {
    // Before this fix only PANES_RUNNING/SWITCH_RATE_LIMITED toasted; every
    // other refusal relied solely on the composable's banner, which sits
    // above the per-agent sections and scrolls out of view — the click
    // looked like it did nothing (2026-09-17).
    const api = makeApi({ profiles: [profile('p1', 'claude', 'Account 2')] })
    const setDefault = api.setDefault as ReturnType<typeof vi.fn>
    setDefault.mockResolvedValue({
      ok: false,
      code: 'PROFILE_SWAP_FAILED',
      message: 'swap failed',
    })
    const w = mountPane(api)

    await buttonByText(section(w, 0), 'Set as Default')!.trigger('click')
    await flushPromises()

    expect(setDefault).toHaveBeenCalledTimes(1)
    expect(notify.toast).toHaveBeenCalledTimes(1)
    expect(notify.toast.mock.calls[0][0]).toBe('swap failed')
  })

  // ── remove ─────────────────────────────────────────────────────────────────

  it('removes a profile only after the inline two-step confirmation', async () => {
    const api = makeApi({ profiles: [profile('p1', 'claude', 'Account 2')] })
    const w = mountPane(api)

    // Step 1: the row's Delete button arms the inline confirm.
    await buttonByText(section(w, 0), 'Delete')!.trigger('click')
    expect(api.remove).not.toHaveBeenCalled()
    expect(section(w, 0).get('.cli-confirm-text').text()).toContain('Delete this account?')

    // Step 2: the danger Delete button performs the removal.
    await section(w, 0).get('.cli-btn.danger').trigger('click')
    await flushPromises()

    expect(api.remove).toHaveBeenCalledWith('p1', 'claude')
    // Confirm state is cleared after a successful remove.
    expect(section(w, 0).find('.cli-confirm-text').exists()).toBe(false)
  })

  it('allows clearing default profile credentials via the delete button', async () => {
    const api = makeApi({
      identities: {
        claude: {
          __default__: { signedIn: true, email: 'a@b.c' } as any,
        },
      },
    })
    const w = mountPane(api)

    // Default card has Delete button when signed in
    await buttonByText(section(w, 0), 'Delete')!.trigger('click')
    expect(section(w, 0).get('.cli-confirm-text').text()).toContain('Delete this account?')

    await section(w, 0).get('.cli-btn.danger').trigger('click')
    await flushPromises()

    expect(api.remove).toHaveBeenCalledWith(null, 'claude')
  })

  // ── error banner ───────────────────────────────────────────────────────────

  it('shows the danger banner when the composable reports an error', () => {
    const w = mountPane(makeApi({ error: 'boom: backend unavailable' }))

    const banner = w.get('.cli-banner.danger')
    expect(banner.text()).toBe('boom: backend unavailable')
  })

  it('shows no banner when there is no error', () => {
    const w = mountPane(makeApi())
    expect(w.find('.cli-banner').exists()).toBe(false)
  })

  // ── usage chips (active row only) ──────────────────────────────────────────

  function usageSnapshot(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
    return {
      provider: 'claude',
      status: 'ok',
      planType: 'max',
      windows: [
        { kind: 'session', label: 'Session', usedPercent: 30, resetsAt: null },
        { kind: 'weekly', label: 'Weekly', usedPercent: 85, resetsAt: null },
      ],
      fetchedAt: '2026-07-26T04:00:00Z',
      error: null,
      ...over,
    }
  }

  it('shows each signed-in account card its own quota snapshot', () => {
    usage.accountUsageFor.mockImplementation((key, profileId) => {
      if (key !== 'claude') return undefined
      return profileId === null
        ? usageSnapshot({
            windows: [{ kind: 'session', label: 'Session', usedPercent: 10, resetsAt: null }],
          })
        : usageSnapshot()
    })
    const api = makeApi({
      profiles: [profile('p1', 'claude', 'Account 2')],
      defaults: { claude: 'p1' },
      identities: {
        claude: {
          __default__: { email: 'default@example.com', signedIn: true },
          p1: { email: 'work@example.com', signedIn: true },
        },
      },
    })
    const w = mountPane(api)

    const cards = section(w, 0).findAll('.cli-card')
    expect(cards[0].get('.cli-card-big').text().replace(/\s+/g, ' ')).toBe('90% Session left')
    expect(cards[1].classes()).toContain('active')
    expect(cards[1].get('.cli-card-big').text().replace(/\s+/g, ' ')).toBe('70% Session left')
    expect(cards[1].findAll('.cli-mini-bar')).toHaveLength(2)
    // Footer carries the non-headline window (Weekly at 15% left).
    expect(cards[1].get('.cli-card-foot').text()).toBe('Weekly 15% left')
  })

  it('names the failure on the card, not just that the refresh failed', () => {
    // Every Claude read failure lands on the same word. A user looking at
    // "unavailable" on a loaded machine reasonably concludes the account is
    // broken and starts re-logging in; the backend knew it was a timeout.
    usage.accountUsageFor.mockImplementation((key, profileId) =>
      key === 'claude' && profileId === null
        ? usageSnapshot({
            stale: true,
            refreshStatus: 'unavailable',
            error: 'claude -p /usage timed out after 180s',
          })
        : undefined,
    )
    const api = makeApi({
      identities: { claude: { __default__: { email: 'default@example.com', signedIn: true } } },
    })
    const w = mountPane(api)

    const card = section(w, 0).findAll('.cli-card')[0]
    expect(card.get('.cli-card-reason').text()).toContain('timed out after 180s')
  })

  it('keeps the reason off a card whose next read is still running', () => {
    usage.accountUsageFor.mockImplementation((key, profileId) =>
      key === 'claude' && profileId === null
        ? usageSnapshot({
            stale: true,
            refreshPending: true,
            refreshStatus: 'unavailable',
            error: 'claude -p /usage timed out after 180s',
          })
        : undefined,
    )
    const api = makeApi({
      identities: { claude: { __default__: { email: 'default@example.com', signedIn: true } } },
    })
    const w = mountPane(api)

    const card = section(w, 0).findAll('.cli-card')[0]
    expect(card.find('.cli-card-reason').exists()).toBe(false)
    expect(card.get('.cli-card-refresh').classes()).toContain('pending')
  })

  it('adds no reason line to a parked account that simply was not measured', () => {
    // A parked slot is not a failure: nothing tried to read it. `error` is
    // null there, and a reason line would invent a problem.
    usage.accountUsageFor.mockImplementation((key, profileId) =>
      key === 'claude' && profileId === null
        ? usageSnapshot({ stale: true, refreshStatus: 'not-measured', error: null })
        : undefined,
    )
    const api = makeApi({
      identities: { claude: { __default__: { email: 'default@example.com', signedIn: true } } },
    })
    const w = mountPane(api)

    expect(section(w, 0).findAll('.cli-card')[0].find('.cli-card-reason').exists()).toBe(false)
  })

  it('falls back to a providers-only snapshot for the active row only', () => {
    usage.accountUsageFor.mockReturnValue(undefined)
    usage.usageFor.mockImplementation((key) => (key === 'claude' ? usageSnapshot() : undefined))
    const api = makeApi({
      profiles: [profile('p1', 'claude', 'Account 2')],
      defaults: { claude: 'p1' },
      identities: {
        claude: { __default__: { email: 'default@example.com', signedIn: true } },
      },
    })
    const w = mountPane(api)

    const cards = section(w, 0).findAll('.cli-card')
    expect(cards[0].find('.cli-card-big').exists()).toBe(false)
    expect(cards[1].get('.cli-card-big').text()).toContain('70%')
  })

  it('shows account snapshots when display identity is missing or signed out', () => {
    usage.accountUsageFor.mockImplementation((key, profileId) => {
      if (key !== 'claude') return undefined
      return profileId === null
        ? usageSnapshot({
            windows: [{ kind: 'session', label: 'Session', usedPercent: 10, resetsAt: null }],
          })
        : usageSnapshot({
            windows: [{ kind: 'session', label: 'Session', usedPercent: 20, resetsAt: null }],
          })
    })
    const api = makeApi({
      profiles: [profile('p1', 'claude', 'Account 2')],
      identities: { claude: { p1: { email: null, signedIn: false } } },
    })
    const w = mountPane(api)

    const cards = section(w, 0).findAll('.cli-card')
    expect(cards[0].get('.cli-card-big').text()).toContain('90%')
    expect(cards[1].get('.cli-card-big').text()).toContain('80%')
  })

  it('shows an expired snapshot when display identity reports signed out', () => {
    usage.accountUsageFor.mockImplementation((key) =>
      key === 'claude' ? usageSnapshot({ status: 'expired', windows: [] }) : undefined,
    )
    const w = mountPane(
      makeApi({
        identities: { claude: { __default__: { email: null, signedIn: false } } },
      }),
    )

    expect(section(w, 0).get('.cli-card-expired').text()).toContain('⚠')
    expect(section(w, 0).get('.cli-card-none').text()).toContain('No quota data yet')
  })

  it('shows cached quota, last success and refresh state on a non-active card', () => {
    usage.accountUsageFor.mockImplementation((_key, profileId) =>
      profileId === null
        ? usageSnapshot({
            stale: true,
            lastSuccessAt: '2026-07-26T04:00:00Z',
            refreshStatus: 'rate-limited',
          })
        : undefined,
    )
    const api = makeApi({
      profiles: [profile('p1', 'claude', 'Account 2')],
      defaults: { claude: 'p1' },
      identities: { claude: { __default__: { email: 'me@x.com', signedIn: true } } },
    })
    const w = mountPane(api)

    const cards = section(w, 0).findAll('.cli-card')
    expect(cards[0].get('.cli-card-big').text()).toContain('70%')
    expect(cards[0].get('.cli-card-cache').text()).toContain('Cached')
    expect(cards[0].get('.cli-card-refresh').text()).toContain('rate limited')
  })

  it('translates the parked-account refresh state instead of printing the raw key', () => {
    // Parked Claude accounts come back as `not-measured`; the pane used to omit
    // it from its own allow-list and render the bare key.
    usage.accountUsageFor.mockReturnValue(
      usageSnapshot({ stale: true, refreshStatus: 'not-measured' }),
    )
    const w = mountPane(
      makeApi({
        identities: { claude: { __default__: { email: 'me@example.com', signedIn: true } } },
      }),
    )
    const refresh = section(w, 0).findAll('.cli-card')[0].get('.cli-card-refresh').text()
    expect(refresh).toContain('Not measured')
    expect(refresh).not.toContain('not-measured')
  })

  it('does not present a cached window after its reset has passed', () => {
    usage.accountUsageFor.mockReturnValue(
      usageSnapshot({
        stale: true,
        staleExpired: true,
        lastSuccessAt: '2026-07-26T04:00:00Z',
        refreshStatus: 'unavailable',
        windows: [
          { kind: 'session', label: 'Session', usedPercent: 30, resetsAt: null, expired: true },
        ],
      }),
    )
    const w = mountPane(
      makeApi({
        identities: { claude: { __default__: { email: 'me@example.com', signedIn: true } } },
      }),
    )
    const card = section(w, 0).findAll('.cli-card')[0]
    expect(card.find('.cli-card-big').exists()).toBe(false)
    expect(card.get('.cli-card-none').text()).toContain('Cached quota reset has passed')
    expect(card.get('.cli-card-cache').text()).toContain('Cached')
  })

  it('says a read is in flight instead of labelling the old figure stale', () => {
    // Right after a switch the card still holds the incoming account's PREVIOUS
    // reading. Calling that "not measured" reads as a dead end; the honest
    // statement is that a read is running and this number predates it.
    usage.accountUsageFor.mockReturnValue(
      usageSnapshot({
        stale: true,
        refreshPending: true,
        lastSuccessAt: '2026-07-26T04:00:00Z',
        refreshStatus: 'not-measured',
      }),
    )
    const w = mountPane(
      makeApi({
        identities: { claude: { __default__: { email: 'me@example.com', signedIn: true } } },
      }),
    )

    const card = section(w, 0).findAll('.cli-card')[0]
    expect(card.get('.cli-card-refresh').text()).toContain('Reading this account')
    // The age of what is on screen still belongs there — it is why the number
    // has not moved.
    expect(card.get('.cli-card-cache').text()).toContain('Cached')
    // ...but not alongside the refresh state it replaces.
    expect(card.text()).not.toContain('Not measured')
  })

  it('says a read is in flight on a card that has no figure at all yet', () => {
    usage.accountUsageFor.mockReturnValue(
      usageSnapshot({ status: 'not-measured', refreshPending: true, windows: [] }),
    )
    const w = mountPane(
      makeApi({
        identities: { claude: { __default__: { email: 'me@example.com', signedIn: true } } },
      }),
    )

    const card = section(w, 0).findAll('.cli-card')[0]
    expect(card.get('.cli-card-none').text()).toContain('No quota data yet')
    expect(card.get('.cli-card-refresh').text()).toContain('Reading this account')
  })

  it('shows no data only for a signed-in account without a snapshot', () => {
    usage.accountUsageFor.mockReturnValue(undefined)
    const api = makeApi({
      profiles: [profile('p1', 'claude', 'Account 2')],
      identities: { claude: { __default__: { email: 'me@x.com', signedIn: true } } },
    })
    const w = mountPane(api)

    const cards = section(w, 0).findAll('.cli-card')
    expect(cards[0].get('.cli-card-none').text()).toContain('No quota data yet')
    expect(cards[1].find('.cli-card-none').exists()).toBe(false)
  })

  it('re-polls usage on mount and after a successful default switch', async () => {
    usage.usageFor.mockReturnValue(undefined)
    const api = makeApi({ profiles: [profile('p1', 'claude', 'Account 2')] })
    const w = mountPane(api)
    expect(usage.refreshUsage).toHaveBeenCalledTimes(1)

    await buttonByText(section(w, 0), 'Set as Default')!.trigger('click')
    await flushPromises()
    expect(usage.refreshUsage).toHaveBeenCalledTimes(2)
  })

  // ── Manual quota refresh ───────────────────────────────────────────────────

  it('re-polls usage from the header button and holds it busy until a payload lands', async () => {
    usage.usageFor.mockReturnValue(undefined)
    const w = mountPane(makeApi())
    expect(usage.refreshUsage).toHaveBeenCalledTimes(1) // mount

    const button = w.get('.cli-refresh')
    await button.trigger('click')
    expect(usage.refreshUsage).toHaveBeenCalledTimes(2)
    expect(button.text()).toBe('Refreshing…')
    expect(button.attributes('disabled')).toBeDefined()

    // A second click while busy must not spawn another poll (reading Claude
    // boots a whole CLI).
    await button.trigger('click')
    expect(usage.refreshUsage).toHaveBeenCalledTimes(2)

    // The poller broadcast that ends the cycle clears the busy state.
    usageVersion.value++
    await flushPromises()
    expect(button.text()).toBe('Refresh All')
    expect(button.attributes('disabled')).toBeUndefined()
  })

  it('keeps the refresh button busy through an announcement payload', async () => {
    // Switching accounts broadcasts a payload immediately to announce the
    // wait. Treating that as "the cycle finished" put an idle Refresh button
    // directly above a card still reading "Reading this account's quota".
    usage.usageFor.mockReturnValue(undefined)
    const w = mountPane(makeApi())
    const button = w.get('.cli-refresh')
    await button.trigger('click')
    expect(button.text()).toBe('Refreshing…')

    usage.usageFor.mockImplementation((agentKey) =>
      agentKey === 'claude' ? usageSnapshot({ refreshPending: true }) : undefined,
    )
    usageVersion.value++
    await flushPromises()
    expect(button.text()).toBe('Refreshing…')

    // The payload that actually ends the read releases it.
    usage.usageFor.mockReturnValue(undefined)
    usageVersion.value++
    await flushPromises()
    expect(button.text()).toBe('Refresh All')
  })

  it('stays idle when there is no backend to ask', async () => {
    usage.usageFor.mockReturnValue(undefined)
    usage.refreshUsage.mockReturnValue(false)
    const w = mountPane(makeApi())

    const button = w.get('.cli-refresh')
    await button.trigger('click')
    expect(button.text()).toBe('Refresh All')
    expect(button.attributes('disabled')).toBeUndefined()
  })

  it('gives the signed-in account card a refresh of its own, scoped to that CLI', async () => {
    usage.usageFor.mockReturnValue(undefined)
    usage.accountUsageFor.mockImplementation((key, profileId) =>
      key === 'claude' && profileId === null ? usageSnapshot() : undefined,
    )
    const api = makeApi({ profiles: [profile('p1', 'claude', 'Account 2')] })
    const w = mountPane(api)
    usage.refreshUsage.mockClear() // drop the mount poll

    const cards = section(w, 0).findAll('.cli-card')
    // The parked account has nothing to ask for: the CLI reports whoever is
    // signed in, so only the active card carries a refresh.
    expect(cards[1].find('.cli-card-refresh-btn').exists()).toBe(false)

    const button = cards[0].get('.cli-card-refresh-btn')
    await button.trigger('click')
    expect(usage.refreshUsage).toHaveBeenCalledWith('claude', null)
    expect(button.text()).toBe('Refreshing…')
    // Separate scope from the header button, which stays clickable.
    expect(w.get('.cli-refresh').attributes('disabled')).toBeUndefined()

    usageVersion.value++
    await flushPromises()
    expect(button.text()).toBe('Refresh Quota')
  })

  it('holds each card busy only while its own CLI is still reading', async () => {
    usage.usageFor.mockReturnValue(undefined)
    usage.accountUsageFor.mockImplementation((key, profileId) =>
      profileId === null && (key === 'claude' || key === 'codex')
        ? usageSnapshot()
        : undefined,
    )
    const w = mountPane(makeApi())

    const claudeBtn = section(w, 0).get('.cli-card-refresh-btn')
    const codexBtn = section(w, 1).get('.cli-card-refresh-btn')
    await claudeBtn.trigger('click')
    await codexBtn.trigger('click')
    expect(usage.refreshUsage).toHaveBeenCalledWith('codex', null)
    expect(claudeBtn.text()).toBe('Refreshing…')
    expect(codexBtn.text()).toBe('Refreshing…')

    // Only Claude is still reading — codex's card must not wait on it.
    usage.usageFor.mockImplementation((key) =>
      key === 'claude' ? usageSnapshot({ refreshPending: true }) : undefined,
    )
    usageVersion.value++
    await flushPromises()
    expect(claudeBtn.text()).toBe('Refreshing…')
    expect(codexBtn.text()).toBe('Refresh Quota')
  })

  it('hides a card refresh where the CLI reports no quota at all', () => {
    usage.usageFor.mockReturnValue(undefined)
    usage.accountUsageFor.mockReturnValue(undefined)
    const w = mountPane(makeApi())

    expect(w.findAll('.cli-card-refresh-btn')).toHaveLength(0)
  })

  it('releases the refresh button when no payload ever arrives', async () => {
    vi.useFakeTimers()
    try {
      usage.usageFor.mockReturnValue(undefined)
      const w = mountPane(makeApi())
      const button = w.get('.cli-refresh')
      await button.trigger('click')
      expect(button.text()).toBe('Refreshing…')

      // One Claude read alone may take 180s, so the net must outlast it.
      vi.advanceTimersByTime(180_000)
      await flushPromises()
      expect(button.text()).toBe('Refreshing…')
      vi.advanceTimersByTime(20_000)
      await flushPromises()
      expect(button.text()).toBe('Refresh All')
      expect(button.attributes('disabled')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  // ── what the figures mean (left, not used) ────────────────────────────────

  it('spells out that every figure is what is left, with the used share on hover', () => {
    // The CLI's own panel prints "N% used"; a bare "100%" on the card was read
    // as an exhausted bucket when it meant an untouched one.
    usage.accountUsageFor.mockReturnValue(
      usageSnapshot({
        windows: [
          { kind: 'session', label: 'Session (5h)', usedPercent: 28, resetsAt: null },
          { kind: 'weekly', label: 'Weekly (all models)', usedPercent: 93, resetsAt: null },
          { kind: 'weekly-model', label: 'Weekly (Fable)', usedPercent: 0, resetsAt: null },
        ],
      }),
    )
    const w = mountPane(
      makeApi({ identities: { claude: { __default__: { email: 'me@x.com', signedIn: true } } } }),
    )

    const card = section(w, 0).findAll('.cli-card')[0]
    expect(card.get('.cli-card-big').text().replace(/\s+/g, ' ')).toBe('72% Session (5h) left')
    expect(card.get('.cli-card-foot').text()).toBe(
      'Weekly (all models) 7% left · Weekly (Fable) 100% left',
    )
    const titles = card.findAll('.cli-mini-bar').map((b) => b.attributes('title'))
    expect(titles[2]).toBe('Weekly (Fable): 100% left (0% used)')
  })

  it('names the Claude windows in the UI language', async () => {
    usage.accountUsageFor.mockReturnValue(
      usageSnapshot({
        windows: [
          { kind: 'session', label: 'Session (5h)', usedPercent: 28, resetsAt: null },
          { kind: 'weekly-model', label: 'Weekly (Fable)', usedPercent: 0, resetsAt: null },
        ],
      }),
    )
    const previous = i18n.global.locale.value
    i18n.global.locale.value = 'zh-TW'
    try {
      const w = mountPane(
        makeApi({ identities: { claude: { __default__: { email: 'me@x.com', signedIn: true } } } }),
      )
      const card = section(w, 0).findAll('.cli-card')[0]
      expect(card.get('.cli-card-big').text()).toContain('工作階段（5 小時） 剩餘')
      expect(card.get('.cli-card-foot').text()).toBe('每週（Fable） 剩 100%')
    } finally {
      i18n.global.locale.value = previous
    }
  })

  it('stamps a current reading with when it was taken', () => {
    usage.accountUsageFor.mockReturnValue(usageSnapshot({ fetchedAt: '2026-07-26T04:00:00Z' }))
    const w = mountPane(
      makeApi({ identities: { claude: { __default__: { email: 'me@x.com', signedIn: true } } } }),
    )
    const updated = section(w, 0).findAll('.cli-card')[0].get('.cli-card-updated').text()
    expect(updated).toMatch(/^updated 7\/26 \d\d:\d\d$/)
  })

  it('stops promising a read once the backend is gone', () => {
    usage.usageBackendConnected.mockReturnValue(false)
    usage.accountUsageFor.mockReturnValue(
      usageSnapshot({ stale: true, refreshPending: true, refreshStatus: 'not-measured' }),
    )
    const w = mountPane(
      makeApi({ identities: { claude: { __default__: { email: 'me@x.com', signedIn: true } } } }),
    )
    expect(section(w, 0).text()).not.toContain('Reading this account')
  })

  // ── signing a parked Claude account in to its own folder ───────────────────

  function parkedApi(accountDirs: CliProfileAccountDirs = {}) {
    return makeApi({
      profiles: [profile('p1', 'claude', 'Account 2')],
      identities: {
        claude: {
          __default__: { email: 'live@x.com', signedIn: true },
          p1: { email: 'parked@x.com', signedIn: true },
        },
      },
      accountDirs,
    })
  }

  function dirActions(): CliAccountDirActions {
    return { continueWith: vi.fn(async () => {}), signIn: vi.fn() }
  }

  it('offers a parked Claude account the sign-in to its own folder and says why', async () => {
    usage.accountUsageFor.mockImplementation((key, profileId) =>
      key === 'claude' && profileId === 'p1'
        ? usageSnapshot({ stale: true, refreshStatus: 'not-measured' })
        : undefined,
    )
    const actions = dirActions()
    const w = mountPane(parkedApi(), { dirActions: actions })

    const cards = section(w, 0).findAll('.cli-card')
    // Never on the built-in Default: it is the real ~/.claude, with no folder.
    expect(cards[0].find('.cli-card-dir-btn').exists()).toBe(false)
    expect(cards[1].get('.cli-card-dir-hint').text()).toContain('own folder')

    await cards[1].get('.cli-card-dir-btn').trigger('click')
    expect(actions.signIn).toHaveBeenCalledWith('claude', 'p1')
    expect(JSON.parse(localStorage.getItem('navide.cliAccountDirExpectedEmail')!)).toEqual({
      p1: 'parked@x.com',
    })
  })

  it('offers no folder sign-in without the main window flow or a workspace', async () => {
    const w = mountPane(parkedApi())
    expect(section(w, 0).find('.cli-card-dir-btn').exists()).toBe(false)
    w.unmount()

    const actions = dirActions()
    const w2 = mountPane(parkedApi(), { dirActions: actions, workspaceOpen: false })
    await section(w2, 0).findAll('.cli-card')[1].get('.cli-card-dir-btn').trigger('click')
    expect(actions.signIn).not.toHaveBeenCalled()
    expect(notify.toast).toHaveBeenCalled()
  })

  it('reads a parked account signed in to its own folder like the live one', async () => {
    usage.usageFor.mockReturnValue(undefined)
    usage.accountUsageFor.mockImplementation((key, profileId) =>
      key === 'claude' && profileId === 'p1' ? usageSnapshot() : undefined,
    )
    const w = mountPane(parkedApi({ claude: { p1: { signedIn: true, email: 'parked@x.com' } } }), {
      dirActions: dirActions(),
    })
    usage.refreshUsage.mockClear()

    const card = section(w, 0).findAll('.cli-card')[1]
    expect(card.find('.cli-card-dir-btn').exists()).toBe(false)
    expect(card.find('.cli-card-dir-hint').exists()).toBe(false)
    await card.get('.cli-card-refresh-btn').trigger('click')
    expect(usage.refreshUsage).toHaveBeenCalledWith('claude', 'p1')
  })

  it('warns, without blocking, when the folder signed in as another account', () => {
    localStorage.setItem('navide.cliAccountDirExpectedEmail', JSON.stringify({ p1: 'parked@x.com' }))
    const other = mountPane(parkedApi({ claude: { p1: { signedIn: true, email: 'other@x.com' } } }), {
      dirActions: dirActions(),
    })
    const warning = section(other, 0).findAll('.cli-card')[1].get('.cli-card-dir-mismatch').text()
    expect(warning).toContain('other@x.com')
    expect(warning).toContain('parked@x.com')
    other.unmount()

    const same = mountPane(parkedApi({ claude: { p1: { signedIn: true, email: 'Parked@x.com' } } }), {
      dirActions: dirActions(),
    })
    expect(section(same, 0).find('.cli-card-dir-mismatch').exists()).toBe(false)
  })

  // ── portable credentials ───────────────────────────────────────────────────

  const PORTABLE_META = {
    agentKey: 'claude',
    slotId: '__default__',
    configured: false,
    enabled: false,
    env: 'CLAUDE_CODE_OAUTH_TOKEN',
    obtainCommand: 'claude setup-token',
    docsUrl: 'https://example.invalid/docs',
  }

  it('offers a compact paste button only on agents with a portable interface', () => {
    const api = makeApi({ portableSupported: ['claude'], cloudStatus: 'ok' })
    const w = mountPane(api)
    // Section 0 is claude, section 1 is codex (CLI_AGENT_SPECS order).
    // An empty slot has no block, just the button in its action row.
    expect(section(w, 0).find('.cli-card-portable').exists()).toBe(false)
    expect(buttonByText(section(w, 0).find('.cli-card-actions'), 'Paste Credential')).toBeDefined()
    expect(buttonByText(section(w, 1), 'Paste Credential')).toBeUndefined()
  })

  it('offers the paste button and saves while credential sync is off', async () => {
    const api = makeApi({ portableSupported: ['claude'], cloudStatus: 'off' })
    const w = mountPane(api)
    const card = section(w, 0).findAll('.cli-card')[0]
    expect(card.find('.cli-card-portable').exists()).toBe(false)
    await buttonByText(card.find('.cli-card-actions'), 'Paste Credential')!.trigger('click')
    await flushPromises()
    await card.get('input.cli-portable-input').setValue('sk-ant-oat01-SYNTHETIC')
    await card.get('form').trigger('submit')
    await flushPromises()
    expect(api.portableSet).toHaveBeenCalledWith('claude', null, 'sk-ant-oat01-SYNTHETIC')
    expect(card.get('.cli-portable-flag').text()).toBe('Set')
    // Sync is off, so the stored credential shows no cloud column.
    expect(card.find('.cli-portable-cloud').exists()).toBe(false)
  })

  it('keeps a stored credential manageable while credential sync is off', () => {
    const api = makeApi({
      portableSupported: ['claude'],
      portable: { 'claude/__default__': { ...PORTABLE_META, configured: true, enabled: true } },
      cloudStatus: 'off',
    })
    const w = mountPane(api)
    const card = section(w, 0).findAll('.cli-card')[0]
    expect(card.find('.cli-card-portable').exists()).toBe(true)
    expect(buttonByText(card, 'Remove from This Device')).toBeDefined()
  })

  it('opens the form from the compact button and collapses again on cancel', async () => {
    const api = makeApi({ portableSupported: ['claude'], cloudStatus: 'ok' })
    const w = mountPane(api)
    const card = section(w, 0).findAll('.cli-card')[0]
    await buttonByText(card, 'Paste Credential')!.trigger('click')
    await flushPromises()
    expect(card.find('input.cli-portable-input').exists()).toBe(true)
    expect(buttonByText(card.find('.cli-card-actions'), 'Paste Credential')).toBeUndefined()
    await buttonByText(card.find('.cli-card-portable'), 'Cancel')!.trigger('click')
    await flushPromises()
    expect(card.find('.cli-card-portable').exists()).toBe(false)
    expect(buttonByText(card.find('.cli-card-actions'), 'Paste Credential')).toBeDefined()
  })

  it('sends the pasted value once and clears the input after saving', async () => {
    const api = makeApi({
      portableSupported: ['claude'],
      portable: { 'claude/__default__': PORTABLE_META },
      cloudStatus: 'ok',
    })
    const w = mountPane(api)
    const card = section(w, 0).findAll('.cli-card')[0]

    await buttonByText(card, 'Paste Credential')!.trigger('click')
    await flushPromises()
    const input = card.get('input.cli-portable-input')
    expect(input.attributes('type')).toBe('password')
    expect(input.attributes('placeholder')).toContain('claude setup-token')
    await input.setValue('  sk-ant-oat01-SYNTHETIC  ')
    await card.get('form').trigger('submit')
    await flushPromises()

    expect(api.portableSet).toHaveBeenCalledTimes(1)
    expect(api.portableSet).toHaveBeenCalledWith('claude', null, 'sk-ant-oat01-SYNTHETIC')
    // The form is gone, the draft with it, and the value appears nowhere.
    expect(card.find('input.cli-portable-input').exists()).toBe(false)
    expect(w.text()).not.toContain('sk-ant-oat01')
    expect(w.html()).not.toContain('sk-ant-oat01')
    // What the card shows now is the metadata the save returned.
    expect(card.get('.cli-portable-flag').text()).toBe('Set')
    expect(card.text()).toContain('CLAUDE_CODE_OAUTH_TOKEN')
    expect(buttonByText(card, 'Replace')).toBeDefined()
    expect(buttonByText(card, 'Remove from This Device')).toBeDefined()
  })

  it('does not save an empty paste', async () => {
    const api = makeApi({ portableSupported: ['claude'], cloudStatus: 'ok' })
    const w = mountPane(api)
    const card = section(w, 0).findAll('.cli-card')[0]
    await buttonByText(card, 'Paste Credential')!.trigger('click')
    await flushPromises()
    expect(card.get('button[type="submit"]').attributes('disabled')).toBeDefined()
    await card.get('form').trigger('submit')
    expect(api.portableSet).not.toHaveBeenCalled()
  })

  it('warns when a local login file shadows the pasted credential', () => {
    const api = makeApi({
      portableSupported: ['claude'],
      portable: {
        'claude/__default__': { ...PORTABLE_META, configured: true, enabled: true, shadowedBy: ['.claude/.credentials.json'] },
      },
    })
    const w = mountPane(api)
    expect(section(w, 0).get('.cli-portable-warn').text()).toContain('.claude/.credentials.json')
  })

  it('removing sends the clear and keeps the wording local', async () => {
    const api = makeApi({
      portableSupported: ['claude'],
      portable: { 'claude/__default__': { ...PORTABLE_META, configured: true, enabled: true } },
    })
    const w = mountPane(api)
    const card = section(w, 0).findAll('.cli-card')[0]
    await buttonByText(card, 'Remove from This Device')!.trigger('click')
    await flushPromises()
    expect(api.portableClear).toHaveBeenCalledWith('claude', null)
  })

  it('fetches the vendor descriptor for an empty slot when the form opens', async () => {
    const api = makeApi({ portableSupported: ['claude'], cloudStatus: 'ok' })
    const w = mountPane(api)
    const card = section(w, 0).findAll('.cli-card')[0]
    await buttonByText(card, 'Paste Credential')!.trigger('click')
    await flushPromises()
    expect(api.portableDescribe).toHaveBeenCalledWith('claude', null)
    expect(card.get('input.cli-portable-input').attributes('placeholder')).toContain('claude setup-token')
    expect(card.text()).toContain('CLAUDE_CODE_OAUTH_TOKEN')
  })

  it('drops the typed value even when the save fails', async () => {
    const api = makeApi({
      portableSupported: ['claude'],
      portable: { 'claude/__default__': PORTABLE_META },
      cloudStatus: 'ok',
    })
    ;(api.portableSet as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      message: 'nope',
    })
    const w = mountPane(api)
    const card = section(w, 0).findAll('.cli-card')[0]
    await buttonByText(card, 'Paste Credential')!.trigger('click')
    await flushPromises()
    await card.get('input.cli-portable-input').setValue('sk-ant-oat01-SYNTHETIC')
    await card.get('form').trigger('submit')
    await flushPromises()

    expect(api.portableSet).toHaveBeenCalledTimes(1)
    // The form stays open for another try, but the value is gone.
    const input = card.get('input.cli-portable-input')
    expect((input.element as HTMLInputElement).value).toBe('')
    expect(w.html()).not.toContain('sk-ant-oat01')
  })

  it('lets the stored credential be selected for new panes and deselected again', async () => {
    const api = makeApi({
      portableSupported: ['claude'],
      portable: { 'claude/__default__': { ...PORTABLE_META, configured: true, enabled: false, source: 'local' } },
    })
    const w = mountPane(api)
    const card = section(w, 0).findAll('.cli-card')[0]
    await buttonByText(card, 'Use for New Panes')!.trigger('click')
    await flushPromises()
    expect(api.portableEnable).toHaveBeenCalledWith('claude', '__default__', true)
    expect(card.text()).toContain('In use')
    await buttonByText(card, 'Stop Using')!.trigger('click')
    await flushPromises()
    expect(api.portableEnable).toHaveBeenLastCalledWith('claude', '__default__', false)
  })

  it('shows a credential imported into a named account elsewhere as its own card', async () => {
    const api = makeApi({
      portableSupported: ['claude'],
      portable: {
        'claude/p-on-other-device': {
          agentKey: 'claude',
          slotId: 'p-on-other-device',
          configured: true,
          enabled: false,
          source: 'imported',
          available: true,
          env: 'CLAUDE_CODE_OAUTH_TOKEN',
        },
      },
    })
    const w = mountPane(api)
    const cards = section(w, 0).findAll('.cli-card')
    // The built-in Default card plus one imported card; no local profile exists.
    expect(cards).toHaveLength(2)
    const imported = cards[1]
    expect(imported.classes()).toContain('cli-card-imported')
    expect(imported.text()).toContain('Account from another device')
    expect(imported.get('.cli-portable-flag').text()).toBe('From cloud')
    // It can be selected and removed here, but not replaced (that is the pasting device's job).
    expect(buttonByText(imported, 'Replace')).toBeUndefined()
    expect(buttonByText(imported, 'Paste Credential')).toBeUndefined()
    expect(buttonByText(imported, 'Remove from This Device')).toBeDefined()
    await buttonByText(imported, 'Use for New Panes')!.trigger('click')
    await flushPromises()
    expect(api.portableEnable).toHaveBeenCalledWith('claude', 'p-on-other-device', true)
    // Its slot id — another install's profile id — is not shown.
    expect(imported.text()).not.toContain('p-on-other-device')
  })

  it('keeps a card for a named account removed here while its cloud copy remains, so it can be taken back', async () => {
    const remoteOnly = {
      itemId: 'c-99999999999999999999999999999999',
      state: 'remote-only' as const,
      localPresent: false,
      remotePresent: true,
      updatedAt: '2026-09-16T05:06:19Z',
      deviceId: 'Studio',
      readable: true,
    }
    // After "Remove from This Device" the backend no longer lists the import;
    // only the cloud inventory still knows the slot.
    const api = makeApi({
      portableSupported: ['claude'],
      portable: {},
      cloudStatus: 'ok',
      cloud: { claude: { 'p-on-other-device': [remoteOnly] } },
    })
    const w = mountPane(api)
    const cards = section(w, 0).findAll('.cli-card')
    expect(cards).toHaveLength(2)
    const card = cards[1]
    expect(card.classes()).toContain('cli-card-imported')
    expect(card.get('.cli-portable-flag').text()).toBe('Not set')
    expect(card.get('.cli-cloud-badge').text()).toBe('In cloud, not used here')
    // Nothing local to paste into or remove; the one action is to take it back.
    expect(buttonByText(card, 'Paste Credential')).toBeUndefined()
    expect(buttonByText(card, 'Remove from This Device')).toBeUndefined()
    await buttonByText(card, 'Use on This Device')!.trigger('click')
    await flushPromises()
    expect(api.useFromCloud).toHaveBeenCalledWith('c-99999999999999999999999999999999')
  })

  it('names an import this device cannot open and does not offer to select it', () => {
    const api = makeApi({
      portableSupported: ['claude'],
      portable: {
        'claude/__default__': { ...PORTABLE_META, configured: true, enabled: false, source: 'imported', available: false },
      },
    })
    const w = mountPane(api)
    const card = section(w, 0).findAll('.cli-card')[0]
    expect(card.get('.cli-portable-warn').text()).toContain('cannot be opened on this device')
    expect(buttonByText(card, 'Use for New Panes')!.attributes('disabled')).toBeDefined()
  })

  // ── cloud column ───────────────────────────────────────────────────────────

  it('shows no cloud column for a stored credential while cloud sync is off', () => {
    const api = makeApi({
      portableSupported: ['claude'],
      portable: { 'claude/__default__': { ...PORTABLE_META, configured: true, enabled: true } },
      cloudStatus: 'off',
    })
    const w = mountPane(api)
    expect(section(w, 0).find('.cli-portable-cloud').exists()).toBe(false)
    expect(section(w, 0).text()).not.toContain('Cloud sync for credentials is off')
  })

  it('shows no cloud column for an empty slot while cloud sync is off', () => {
    const api = makeApi({ portableSupported: ['claude'], cloudStatus: 'off' })
    const w = mountPane(api)
    expect(section(w, 0).find('.cli-portable-cloud').exists()).toBe(false)
  })

  it('shows each cloud copy by state, with when and where it last changed', () => {
    const api = makeApi({
      portableSupported: ['claude'],
      portable: { 'claude/__default__': { ...PORTABLE_META, configured: true, enabled: true } },
      cloudStatus: 'ok',
      cloud: {
        claude: {
          __default__: [
            {
              itemId: 'c-0123456789abcdef0123456789abcdef',
              state: 'in-sync',
              localPresent: true,
              remotePresent: true,
              updatedAt: '2026-09-16T05:06:19Z',
              deviceId: 'MacBook',
              readable: true,
            },
          ],
        },
      },
    })
    const w = mountPane(api)
    const cloud = section(w, 0).findAll('.cli-card')[0].find('.cli-portable-cloud')
    expect(cloud.get('.cli-cloud-badge').text()).toBe('In sync')
    expect(cloud.text()).toContain('MacBook')
    // Opaque ids are for the engine, not the person.
    expect(cloud.text()).not.toContain('c-0123456789abcdef')
    expect(buttonByText(cloud, 'Use on This Device')).toBeUndefined()
  })

  it('lets a cloud-only credential be taken into use here by its item id', async () => {
    const api = makeApi({
      portableSupported: ['claude'],
      cloudStatus: 'ok',
      cloud: {
        claude: {
          __default__: [
            {
              itemId: 'c-feedfacefeedfacefeedfacefeedface',
              state: 'remote-only',
              localPresent: false,
              remotePresent: true,
              updatedAt: '2026-09-16T05:06:19Z',
              deviceId: 'Studio',
              readable: true,
            },
          ],
        },
      },
    })
    const w = mountPane(api)
    const cloud = section(w, 0).findAll('.cli-card')[0].find('.cli-portable-cloud')
    expect(cloud.get('.cli-cloud-badge').text()).toBe('In cloud, not used here')
    await buttonByText(cloud, 'Use on This Device')!.trigger('click')
    await flushPromises()
    expect(api.useFromCloud).toHaveBeenCalledWith('c-feedfacefeedfacefeedfacefeedface')
  })

  it('names a cloud copy this device cannot open instead of offering it', () => {
    const api = makeApi({
      portableSupported: ['claude'],
      cloudStatus: 'ok',
      cloud: {
        claude: {
          __default__: [
            {
              itemId: 'c-00000000000000000000000000000000',
              state: 'remote-only',
              localPresent: false,
              remotePresent: true,
              updatedAt: '',
              deviceId: 'Studio',
              readable: false,
            },
          ],
        },
      },
    })
    const w = mountPane(api)
    const cloud = section(w, 0).findAll('.cli-card')[0].find('.cli-portable-cloud')
    expect(cloud.text()).toContain('Sealed under a key this device does not hold')
    expect(buttonByText(cloud, 'Use on This Device')).toBeUndefined()
  })
})
