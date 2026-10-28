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
    // Row 0 is the built-in Default (no identity -> "Original login" label).
    expect(names).toEqual(['Original login', 'me@example.com', 'Account 3', 'Not signed in'])
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

  it('with an empty Default, signIn on another non-active profile asks nothing and switches nothing', async () => {
    const api = makeApi({
      profiles: [profile('p1', 'claude', 'Account 2'), profile('p2', 'claude', 'Account 3')],
      defaults: { claude: 'p1' },
      identities: { claude: { p1: { email: 'me@example.com', signedIn: true } } },
    })
    const w = mountPane(api)

    // Row 0 is the collapsed empty Default, row 1 the active p1, row 2 p2.
    const row = section(w, 0).findAll('.cli-card')[2]
    await row.findAll('button').find((b) => b.text() === 'Sign In')!.trigger('click')
    await flushPromises()

    expect(notify.confirm).not.toHaveBeenCalled()
    expect(api.setDefault).not.toHaveBeenCalled()
    expect(w.emitted('login')).toEqual([['claude', 'p2']])
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

    // The Default is empty, so the switch clears the live login: asked first.
    expect(notify.confirm).toHaveBeenCalledTimes(1)
    const [body, opts] = notify.confirm.mock.calls[0] as [string, { title?: string; confirmText?: string }]
    expect(opts.title).toBe('Switch to the Original Login?')
    expect(opts.confirmText).toBe('Switch and Sign In')
    expect(body).toContain('the live login (Not signed in) is cleared')
    expect(api.setDefault).toHaveBeenCalledWith('claude', null)
    expect(w.emitted('login')).toEqual([['claude']])
  })

  it('a declined confirm on the empty Default neither switches nor signs in', async () => {
    const api = makeApi({
      profiles: [profile('p1', 'claude', 'Account 2')],
      defaults: { claude: 'p1' },
      identities: { claude: { p1: { email: 'me@example.com', signedIn: true } } },
    })
    notify.confirm.mockResolvedValueOnce(false)
    const w = mountPane(api)

    const defaultRow = section(w, 0).findAll('.cli-card')[0]
    await defaultRow.findAll('button').find((b) => b.text() === 'Sign In')!.trigger('click')
    await flushPromises()

    expect((notify.confirm.mock.calls[0] as [string])[0]).toContain('(me@example.com)')
    expect(api.setDefault).not.toHaveBeenCalled()
    expect(w.emitted('login')).toBeUndefined()
  })

  it('Sign In on a signed-in (expired) Default switches without the empty-slot confirm', async () => {
    const api = makeApi({
      profiles: [profile('p1', 'claude', 'Account 2')],
      defaults: { claude: 'p1' },
      identities: { claude: { __default__: { email: 'a@b.c', signedIn: true } } },
    })
    usage.accountUsageFor.mockImplementation((_key, profileId) =>
      profileId === null ? usageSnapshot({ status: 'expired' }) : undefined,
    )
    const w = mountPane(api)

    const defaultRow = section(w, 0).findAll('.cli-card')[0]
    await defaultRow.findAll('button').find((b) => b.text() === 'Sign In')!.trigger('click')
    await flushPromises()

    expect(notify.confirm).not.toHaveBeenCalled()
    expect(api.setDefault).toHaveBeenCalledWith('claude', null)
  })

  // ── the built-in Default card ──────────────────────────────────────────────

  it('collapses an empty, inactive Default to one line with only Sign In', () => {
    const api = makeApi({
      profiles: [profile('p1', 'claude', 'Account 2')],
      defaults: { claude: 'p1' },
      identities: { claude: { p1: { email: 'me@example.com', signedIn: true } } },
    })
    const w = mountPane(api)

    const row = section(w, 0).findAll('.cli-card')[0]
    expect(row.classes()).toContain('cli-card-collapsed')
    expect(row.text()).toContain('Original login (outside Navide): not signed in')
    expect(row.findAll('button').map((b) => b.text())).toEqual(['Sign In'])
    // The active profile carries the "Active" badge.
    expect(section(w, 0).findAll('.cli-card')[1].get('.cli-badge').text()).toBe('Active')
  })

  it('keeps an empty Default as a full card while it is the active account', () => {
    const w = mountPane(makeApi({ profiles: [profile('p1', 'claude', 'Account 2')] }))

    const row = section(w, 0).findAll('.cli-card')[0]
    expect(row.classes()).not.toContain('cli-card-collapsed')
    expect(row.get('.cli-card-id').text()).toBe('Original login')
    expect(row.get('.cli-badge').text()).toBe('Active')
    expect(buttonByText(row, 'Sign In')).toBeDefined()
  })

  it('a signed-in, inactive Default is a full card that can be switched to', () => {
    const api = makeApi({
      profiles: [profile('p1', 'claude', 'Account 2')],
      defaults: { claude: 'p1' },
      identities: { claude: { __default__: { email: 'a@b.c', signedIn: true } } },
    })
    const w = mountPane(api)

    const row = section(w, 0).findAll('.cli-card')[0]
    expect(row.classes()).not.toContain('cli-card-collapsed')
    expect(row.text()).toContain('Your original login credentials')
    expect(buttonByText(row, 'Switch to This Account')).toBeDefined()
  })

  it('sets a profile as default via the Set as default button', async () => {
    const api = makeApi({ profiles: [profile('p1', 'claude', 'Account 2')] })
    const setDefault = api.setDefault as ReturnType<typeof vi.fn>
    const w = mountPane(api)

    // Default is null, so the profile row shows "Switch to This Account".
    await buttonByText(section(w, 0), 'Switch to This Account')!.trigger('click')
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

    await buttonByText(section(w, 0), 'Switch to This Account')!.trigger('click')
    await flushPromises()

    const busy = buttonByText(section(w, 0), 'Switching…')
    expect(busy).toBeDefined()
    expect(busy!.attributes('disabled')).toBeDefined()
    expect(buttonByText(section(w, 0), 'Switch to This Account')).toBeUndefined()

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

    await buttonByText(section(w, 0), 'Switch to This Account')!.trigger('click')
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

    await buttonByText(section(w, 0), 'Switch to This Account')!.trigger('click')
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

    await buttonByText(section(w, 0), 'Switch to This Account')!.trigger('click')
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

    await buttonByText(section(w, 0), 'Switch to This Account')!.trigger('click')
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

    await buttonByText(section(w, 0), 'Switch to This Account')!.trigger('click')
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

    await buttonByText(section(w, 0), 'Switch to This Account')!.trigger('click')
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
    // The stamp is shown in local time, so build the reading from a local
    // wall-clock time; a fixed UTC instant lands on 7/25 west of UTC-4.
    const fetchedAt = new Date(2026, 6, 26, 4, 0).toISOString()
    usage.accountUsageFor.mockReturnValue(usageSnapshot({ fetchedAt }))
    const w = mountPane(
      makeApi({ identities: { claude: { __default__: { email: 'me@x.com', signedIn: true } } } }),
    )
    const updated = section(w, 0).findAll('.cli-card')[0].get('.cli-card-updated').text()
    expect(updated).toBe('updated 7/26 04:00')
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
})
